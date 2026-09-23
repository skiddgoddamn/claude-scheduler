// Run: node test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const now = new Date(2026, 8, 23, 14, 0, 0); // 23.09.2026 14:00 local
const MIN = 60 * 1000;
const at = (d, h, m) => new Date(2026, 8, d, h, m).getTime();

// parseWhen
assert.strictEqual(lib.parseWhen('', now), now.getTime());
assert.strictEqual(lib.parseWhen('сейчас', now), now.getTime());
assert.strictEqual(lib.parseWhen('+30', now), now.getTime() + 30 * MIN);
assert.strictEqual(lib.parseWhen('45m', now), now.getTime() + 45 * MIN);
assert.strictEqual(lib.parseWhen('+2ч', now), now.getTime() + 120 * MIN);
assert.strictEqual(lib.parseWhen('15:05', now), at(23, 15, 5));
assert.strictEqual(lib.parseWhen('13:00', now), at(24, 13, 0), 'past clock time rolls to tomorrow');
assert.strictEqual(lib.parseWhen('24.09 09:00', now), at(24, 9, 0));
assert.strictEqual(lib.parseWhen('25:00', now), null);
assert.strictEqual(lib.parseWhen('31.02 10:00', now), null);
assert.strictEqual(lib.parseWhen('завтра', now), null);

// reset time / retry
assert.strictEqual(lib.parseResetTime('Claude AI usage limit reached|1758625200', now), 1758625200000);
assert.strictEqual(lib.parseResetTime("You've hit your limit · resets 3pm (Europe/Moscow)", now), at(23, 15, 0));
assert.strictEqual(lib.parseResetTime('5-hour limit reached ∙ resets 12am', now), at(24, 0, 0));
assert.strictEqual(lib.parseResetTime('resets 15:30', now), at(23, 15, 30));
assert.strictEqual(lib.parseResetTime('boom', now), null);
assert.strictEqual(lib.nextRetryAt('resets 3pm', now, 15), at(23, 15, 2), 'reset + 2 min buffer');
assert.strictEqual(lib.nextRetryAt('limit reached', now, 15), now.getTime() + 15 * MIN, 'no reset time -> retryMinutes');

// interpretRun
const res = (o) => JSON.stringify({ type: 'result', ...o });
assert.deepStrictEqual(lib.interpretRun({ code: 0, stdout: res({ subtype: 'success', is_error: false, result: 'ок' }), stderr: '' }), { kind: 'done', text: 'ок' });
assert.strictEqual(lib.interpretRun({ code: 1, stdout: res({ is_error: true, result: "You've hit your limit · resets 3pm" }), stderr: '' }).kind, 'limit');
assert.strictEqual(lib.interpretRun({ code: 1, stdout: res({ is_error: true, result: 'API Error: 500' }), stderr: '' }).kind, 'error');
assert.strictEqual(lib.interpretRun({ code: 1, stdout: '', stderr: 'Claude AI usage limit reached|1758625200' }).kind, 'limit');
assert.strictEqual(lib.interpretRun({ code: -1, stdout: '', stderr: 'spawn claude ENOENT' }).kind, 'error');

// jobs store + cross-window claim
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csched-'));
const jobsFile = path.join(tmp, 'jobs.json');
assert.deepStrictEqual(lib.loadJobs(jobsFile), []);
lib.addJob(jobsFile, { id: 'a', status: 'pending', attempts: 0 });
lib.addJob(jobsFile, { id: 'b', status: 'pending', attempts: 0 });
assert.strictEqual(lib.updateJob(jobsFile, 'a', { status: 'running' }).status, 'running');
assert.strictEqual(lib.updateJob(jobsFile, 'zzz', { status: 'running' }), null);
lib.removeJob(jobsFile, 'b');
assert.deepStrictEqual(lib.loadJobs(jobsFile).map((j) => j.id), ['a']);
assert.strictEqual(lib.claim(tmp, 'a-0'), true);
assert.strictEqual(lib.claim(tmp, 'a-0'), false, 'second window loses the race');
assert.strictEqual(lib.claim(tmp, 'a-1'), true, 'next attempt gets a fresh lock');
lib.dropLocks(tmp, 'a');
assert.strictEqual(lib.claim(tmp, 'a-0'), true);

// session meta + listing from a fake ~/.claude/projects
const proj = path.join(tmp, 'projects', 'd--work');
fs.mkdirSync(proj, { recursive: true });
const lines = [
  { type: 'queue-operation' },
  { type: 'user', cwd: 'd:\\work', message: { content: '<command-name>/clear</command-name>' } },
  { type: 'user', cwd: 'd:\\work', message: { content: [{ type: 'text', text: 'почини   логин' }] } },
  { type: 'ai-title', aiTitle: 'Старое название' },
  { type: 'ai-title', aiTitle: 'Починка логина' },
];
fs.writeFileSync(path.join(proj, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(path.join(proj, 's2.jsonl'), JSON.stringify(lines[2]) + '\n');
fs.utimesSync(path.join(proj, 's1.jsonl'), new Date(2026, 0, 1), new Date(2026, 0, 1));
const sessions = lib.listSessions(10, path.join(tmp, 'projects'));
assert.deepStrictEqual(sessions.map((s) => s.sessionId), ['s2', 's1'], 'newest first');
assert.strictEqual(sessions[1].title, 'Починка логина', 'latest ai-title wins');
assert.strictEqual(sessions[1].cwd, 'd:\\work');
assert.strictEqual(sessions[0].title, 'почини логин', 'falls back to first real prompt');
assert.strictEqual(lib.listSessions(1, path.join(tmp, 'projects')).length, 1);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok');
