// Pure helpers without the vscode import, so test.js runs under plain node.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const SETTINGS_FILE = path.join(CLAUDE_HOME, 'settings.json');
const HOOK_EVENTS = ['PostToolUse', 'Stop'];
const TURN_END = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const TITLE_MAX = 60;
const RESULT_MAX = 2000;
const RESET_BUFFER_MS = 2 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const STALE_MS = 15 * MINUTE;

// ---------- sessions (~/.claude/projects/<slug>/<uuid>.jsonl) ----------

function readChunk(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // chunk edges cut lines in half, skip them
    }
  }
  return out;
}

function promptText(entry) {
  if (entry.type !== 'user' || !entry.message || entry.isMeta) return null;
  const c = entry.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((p) => p.type === 'text') || {}).text : null;
  if (!text || text.startsWith('<')) return null; // <command-name>, <system-reminder>...
  return text;
}

function shorten(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

// Transcripts grow to megabytes: read only the head (cwd, first prompt) and the tail (latest title).
function readSessionMeta(file) {
  const { size, mtimeMs } = fs.statSync(file);
  const head = parseLines(readChunk(file, 0, Math.min(size, HEAD_BYTES)));
  const tail = size > HEAD_BYTES ? parseLines(readChunk(file, Math.max(0, size - TAIL_BYTES), TAIL_BYTES)) : head;
  const all = head.concat(tail);
  const cwd = (all.find((e) => e.cwd) || {}).cwd || null;
  const aiTitle = [...tail].reverse().find((e) => e.type === 'ai-title' && e.aiTitle);
  const lastPrompt = [...tail].reverse().find((e) => e.type === 'last-prompt' && e.lastPrompt);
  const firstPrompt = head.map(promptText).find(Boolean);
  const title = (aiTitle && aiTitle.aiTitle) || (lastPrompt && lastPrompt.lastPrompt) || firstPrompt || path.basename(file, '.jsonl');
  return { sessionId: path.basename(file, '.jsonl'), file, cwd, title: shorten(title, TITLE_MAX), mtime: mtimeMs };
}

function listSessions(limit, root = PROJECTS_DIR) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const full = path.join(root, dir.name);
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(full, name);
      files.push({ file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => readSessionMeta(f.file));
}

// ---------- time parsing ----------

const UNIT_MS = { m: MINUTE, min: MINUTE, 'м': MINUTE, 'мин': MINUTE, h: HOUR, 'ч': HOUR };

function atClock(now, hh, mm) {
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// '' | 'сейчас' -> now; '+30' | '30m' | '2ч' -> relative; '15:05' -> next such time; '24.09 09:00' -> that date.
// Returns epoch ms or null when the input is not understood.
function parseWhen(input, now) {
  const s = String(input || '').trim().toLowerCase();
  if (s === '' || s === 'now' || s === 'сейчас') return now.getTime();

  const rel = s.match(/^\+?\s*(\d+)\s*(m|min|м|мин|h|ч)?$/);
  if (rel) return now.getTime() + Number(rel[1]) * UNIT_MS[rel[2] || 'm'];

  const clock = s.match(/^(\d{1,2})[:.](\d{2})$/);
  if (clock) {
    const [hh, mm] = [Number(clock[1]), Number(clock[2])];
    return hh < 24 && mm < 60 ? atClock(now, hh, mm) : null;
  }

  const dated = s.match(/^(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (dated) {
    const [dd, mo, hh, mm] = dated.slice(1).map(Number);
    const d = new Date(now.getFullYear(), mo - 1, dd, hh, mm);
    if (d.getMonth() !== mo - 1 || d.getDate() !== dd || hh > 23 || mm > 59) return null;
    if (d.getTime() <= now.getTime()) d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
  }
  return null;
}

// ---------- claude -p result interpretation ----------

const LIMIT_RE = /usage limit|limit reached|hit your limit|rate[ _-]?limit|resets? (at )?\d/i;

// Reset time from a limit message: "…limit reached|1758625200" or "…resets 3pm" / "resets 15:00".
function parseResetTime(text, now) {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const ampm = (m[3] || '').toLowerCase();
  if (ampm === 'pm' && hh < 12) hh += 12;
  if (ampm === 'am' && hh === 12) hh = 0;
  return hh < 24 ? atClock(now, hh, Number(m[2] || 0)) : null;
}

function nextRetryAt(text, now, retryMinutes) {
  const reset = parseResetTime(text, now);
  return reset && reset > now.getTime() ? reset + RESET_BUFFER_MS : now.getTime() + retryMinutes * MINUTE;
}

// -> { kind: 'done' | 'limit' | 'error', text }
function interpretRun({ code, stdout, stderr }) {
  let json = null;
  try {
    json = JSON.parse(stdout.trim().split('\n').pop());
  } catch {
    // not JSON: crash, auth prompt, spawn error — fall through to raw text
  }
  if (json && json.type === 'result') {
    const text = String(json.result || json.subtype || '');
    if (!json.is_error) return { kind: 'done', text: text.slice(0, RESULT_MAX) };
    return { kind: LIMIT_RE.test(`${text}\n${stderr}`) ? 'limit' : 'error', text: text.slice(0, RESULT_MAX) };
  }
  const raw = (stderr || stdout || `exit code ${code}`).trim().slice(0, RESULT_MAX);
  if (LIMIT_RE.test(`${stdout}\n${stderr}`)) return { kind: 'limit', text: raw };
  return { kind: code === 0 ? 'done' : 'error', text: raw };
}

// ---------- jobs store (one JSON file shared by all VS Code windows) ----------

function loadJobs(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function saveJobs(file, jobs) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  fs.renameSync(tmp, file);
}

// ponytail: read-modify-write without a file lock; two windows editing within the same ms can lose one edit.
function addJob(file, job) {
  saveJobs(file, [...loadJobs(file), job]);
}

function updateJob(file, id, patch) {
  let updated = null;
  const jobs = loadJobs(file).map((j) => (j.id === id ? (updated = { ...j, ...patch }) : j));
  if (updated) saveJobs(file, jobs);
  return updated;
}

function removeJob(file, id) {
  saveJobs(file, loadJobs(file).filter((j) => j.id !== id));
}

// Each (job, attempt) runs exactly once across all windows: whoever creates the lock file first wins.
function claim(lockDir, key) {
  try {
    fs.closeSync(fs.openSync(path.join(lockDir, `${key}.lock`), 'wx'));
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

function release(lockDir, key) {
  fs.rmSync(path.join(lockDir, `${key}.lock`), { force: true });
}

function dropLocks(lockDir, id) {
  for (const name of fs.readdirSync(lockDir)) {
    if (name.startsWith(`${id}-`)) fs.rmSync(path.join(lockDir, name), { force: true });
  }
}

// ---------- is the session mid-turn? ----------

function isInterrupt(entry) {
  const c = entry.message && entry.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('') : '';
  return text.startsWith('[Request interrupted');
}

// Busy = its process is mid-turn: the last message is a tool call or a prompt still waiting for the model.
// Resuming a busy session from another process forks it, so busy sessions get messages via the hook.
// A transcript untouched for STALE_MS counts as idle (process closed or crashed mid-turn).
function isSessionBusy(file, now = Date.now()) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (now - st.mtimeMs > STALE_MS) return false;
  const tail = parseLines(readChunk(file, Math.max(0, st.size - TAIL_BYTES), Math.min(st.size, TAIL_BYTES)));
  const last = [...tail].reverse().find((e) => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain);
  if (!last) return false;
  if (last.type === 'assistant') return !TURN_END.has(last.message && last.message.stop_reason);
  return !isInterrupt(last);
}

// ---------- inbox read by hook.js: <inbox>/<sessionId>/<jobId>.msg ----------

const inboxFile = (inbox, sessionId, jobId, ext) => path.join(inbox, path.basename(sessionId), `${jobId}.${ext}`);

function putInbox(inbox, sessionId, jobId, text) {
  const tmp = inboxFile(inbox, sessionId, jobId, 'tmp');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, inboxFile(inbox, sessionId, jobId, 'msg'));
}

// 'waiting' | 'taken' (hook delivered it) | 'missing'
function inboxState(inbox, sessionId, jobId) {
  if (fs.existsSync(inboxFile(inbox, sessionId, jobId, 'taken'))) return 'taken';
  if (fs.existsSync(inboxFile(inbox, sessionId, jobId, 'msg'))) return 'waiting';
  return 'missing';
}

// Take the message back before the hook does; false when the hook was faster.
function withdrawInbox(inbox, sessionId, jobId) {
  try {
    fs.renameSync(inboxFile(inbox, sessionId, jobId, 'msg'), inboxFile(inbox, sessionId, jobId, 'withdrawn'));
    return true;
  } catch {
    return false;
  }
}

function clearInbox(inbox, sessionId, jobId) {
  for (const ext of ['msg', 'taken', 'withdrawn', 'tmp']) fs.rmSync(inboxFile(inbox, sessionId, jobId, ext), { force: true });
}

// ---------- hook line for ~/.claude/settings.json (the user pastes it; we only read settings) ----------

const hookCommand = (hookScript, inbox) => `node "${hookScript.replace(/\\/g, '/')}" "${inbox.replace(/\\/g, '/')}"`;

function hasHook(settings, command) {
  const hooks = (settings && settings.hooks) || {};
  return HOOK_EVENTS.every((ev) => (hooks[ev] || []).some((g) => (g.hooks || []).some((h) => h.command === command)));
}

function hookInstalled(command, file = SETTINGS_FILE) {
  try {
    return hasHook(JSON.parse(fs.readFileSync(file, 'utf8')), command);
  } catch {
    return false;
  }
}

function hookSnippet(command) {
  const entry = [{ matcher: '*', hooks: [{ type: 'command', command }] }];
  return JSON.stringify(Object.fromEntries(HOOK_EVENTS.map((ev) => [ev, entry])), null, 2);
}

module.exports = {
  SETTINGS_FILE,
  isSessionBusy,
  putInbox,
  inboxState,
  withdrawInbox,
  clearInbox,
  hookCommand,
  hasHook,
  hookInstalled,
  hookSnippet,
  listSessions,
  readSessionMeta,
  parseWhen,
  parseResetTime,
  nextRetryAt,
  interpretRun,
  loadJobs,
  addJob,
  updateJob,
  removeJob,
  claim,
  release,
  dropLocks,
};
