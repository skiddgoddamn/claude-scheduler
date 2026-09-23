const vscode = require('vscode');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const TICK_MS = 30 * 1000;
const BUSY_RETRY_MS = 60 * 1000;
const MAX_ATTEMPTS = 24;
const SESSION_PICK_LIMIT = 30;
const CLAUDE_EXT_ID = 'anthropic.claude-code';
const CLAUDE_PANEL_VIEWTYPE = 'claudeVSCodePanel';

const STATUS = {
  pending: {
    icon: 'clock',
    text: (j) => [j.attempts ? `повтор ${fmt(j.at)} · попытка ${j.attempts + 1}` : fmt(j.at), j.note].filter(Boolean).join(' · '),
  },
  queued: { icon: 'mail', text: (j) => `ждёт шага Claude с ${fmt(j.queuedAt)}` },
  running: { icon: 'sync~spin', text: () => 'выполняется…' },
  done: { icon: 'pass', text: (j) => `готово ${fmt(j.finishedAt)}` },
  failed: { icon: 'error', text: (j) => `ошибка ${fmt(j.finishedAt)}` },
};

const running = new Map(); // jobId -> child process started by this window
let store; // paths in globalStorage, shared by all windows
let hookCmd; // the line the user pastes into ~/.claude/settings.json
let hookOffered = false;
let out;

function activate(context) {
  const dir = context.globalStorageUri.fsPath;
  store = {
    jobs: path.join(dir, 'jobs.json'),
    locks: path.join(dir, 'locks'),
    inbox: path.join(dir, 'inbox'),
    hookScript: path.join(dir, 'hook.js'),
  };
  fs.mkdirSync(store.locks, { recursive: true });
  // Stable path for settings.json; refreshed on every start so it follows extension updates.
  fs.copyFileSync(path.join(context.extensionPath, 'hook.js'), store.hookScript);
  hookCmd = lib.hookCommand(store.hookScript, store.inbox);
  out = vscode.window.createOutputChannel('Claude Scheduler');

  const changed = new vscode.EventEmitter();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'claudeScheduler.jobs.focus';
  const refresh = () => {
    changed.fire();
    updateStatus(status);
  };

  const tree = vscode.window.createTreeView('claudeScheduler.jobs', {
    treeDataProvider: {
      onDidChangeTreeData: changed.event,
      getChildren: () => sortJobs(lib.loadJobs(store.jobs)),
      getTreeItem: jobItem,
    },
    canSelectMany: true,
  });
  const isFinished = (j) => j.status === 'done' || j.status === 'failed';

  const timer = setInterval(() => tick(refresh), TICK_MS);
  context.subscriptions.push(
    out,
    status,
    tree,
    { dispose: () => clearInterval(timer) },
    command('claudeScheduler.schedule', () => schedule(refresh)),
    command('claudeScheduler.runNow', (job) => runNow(job, refresh)),
    command('claudeScheduler.remove', (job, selected) => remove(targets(job, selected, tree), refresh)),
    command('claudeScheduler.removeMany', () => removeMany(refresh)),
    command('claudeScheduler.openSession', openSession),
    command('claudeScheduler.clearFinished', () => remove(lib.loadJobs(store.jobs).filter(isFinished), refresh)),
    command('claudeScheduler.showLog', () => out.show()),
    command('claudeScheduler.setupHook', showHookSetup),
  );
  tick(refresh);
}

function deactivate() {
  for (const [id, child] of running) {
    child.kill();
    lib.updateJob(store.jobs, id, { status: 'failed', finishedAt: Date.now(), lastError: 'VS Code закрыли во время выполнения' });
  }
}

function command(id, fn) {
  return vscode.commands.registerCommand(id, async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      log(`✖ ${id}: ${e.stack || e}`);
      vscode.window.showErrorMessage(`Claude Scheduler: ${e.message}`);
    }
  });
}

// ---------- scheduling ----------

async function schedule(refresh) {
  const sessions = lib.listSessions(SESSION_PICK_LIMIT);
  if (!sessions.length) {
    vscode.window.showWarningMessage('Не нашёл ни одной сессии в ~/.claude/projects');
    return;
  }
  // Invoked from a Claude tab's title button -> put that session first.
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const isActive = (s) => !!activeTab && sameTitle(activeTab.label, s.title);
  const ordered = [...sessions.filter(isActive), ...sessions.filter((s) => !isActive(s))];

  const picks = await vscode.window.showQuickPick(
    ordered.map((s) => ({
      label: s.title,
      description: `${path.basename(s.cwd || '?')} · ${ago(s.mtime)}`,
      detail: s.sessionId,
      picked: isActive(s),
      session: s,
    })),
    { title: 'Отложенное сообщение: в какие сессии? (можно несколько)', canPickMany: true, matchOnDescription: true, matchOnDetail: true },
  );
  if (!picks || !picks.length) return;

  const when = await vscode.window.showInputBox({
    title: 'Когда отправить?',
    prompt: '15:05 · 24.09 09:00 · +30m · +2h · пусто = сразу (если лимит — будет повторять, пока не пройдёт)',
    validateInput: (v) => (lib.parseWhen(v, new Date()) === null ? 'Не понял время. Примеры: 15:05, +30m, +2h, 24.09 09:00' : null),
  });
  if (when === undefined) return;

  const prompt = await vscode.window.showInputBox({
    title: 'Текст сообщения',
    value: config().get('defaultPrompt'),
    validateInput: (v) => (v.trim() ? null : 'Пустое сообщение'),
  });
  if (prompt === undefined) return;

  const at = lib.parseWhen(when, new Date());
  for (const { session: s } of picks) {
    lib.addJob(store.jobs, {
      id: crypto.randomUUID(),
      sessionId: s.sessionId,
      file: s.file,
      cwd: s.cwd,
      title: s.title,
      prompt: prompt.trim(),
      at,
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
    });
    log(`＋ «${s.title}» на ${fmt(at)}: ${prompt.trim()}`);
  }
  const target = picks.length === 1 ? `«${picks[0].session.title}»` : `${picks.length} ${sessionsWord(picks.length)}`;
  vscode.window.showInformationMessage(`Отправлю в ${target} ${fmt(at)}`);
  tick(refresh);
}

// A fresh seq also frees a job whose step was cut short (VS Code killed mid-run left its lock behind).
async function runNow(job, refresh) {
  const fresh = lib.loadJobs(store.jobs).find((j) => j.id === job.id);
  if (!fresh) return;
  lib.updateJob(store.jobs, job.id, { status: 'pending', at: Date.now(), seq: (fresh.seq || 0) + 1, note: undefined });
  tick(refresh);
}

// Inline button / context menu pass (clicked, selection); the Delete key passes nothing.
function targets(job, selected, tree) {
  if (!job) return [...tree.selection];
  return selected && selected.some((s) => s.id === job.id) ? selected : [job];
}

async function remove(jobs, refresh) {
  if (!jobs.length) return;
  const busy = jobs.filter((j) => running.has(j.id));
  if (busy.length) {
    const names = busy.map((j) => `«${j.title}»`).join(', ');
    const ok = await vscode.window.showWarningMessage(`Остановить выполнение: ${names}?`, { modal: true }, 'Остановить');
    if (!ok) return;
    busy.forEach((j) => running.get(j.id).kill());
  }
  for (const job of jobs) {
    lib.removeJob(store.jobs, job.id);
    lib.dropLocks(store.locks, job.id);
    lib.clearInbox(store.inbox, job.sessionId, job.id); // so the hook won't deliver a cancelled message
  }
  refresh();
}

async function removeMany(refresh) {
  const jobs = sortJobs(lib.loadJobs(store.jobs));
  if (!jobs.length) {
    vscode.window.showInformationMessage('Нет отложенных сообщений');
    return;
  }
  const picks = await vscode.window.showQuickPick(
    jobs.map((j) => ({ label: j.title, description: statusOf(j).text(j), detail: j.prompt, job: j })),
    { title: 'Какие отложенные сообщения удалить?', canPickMany: true, matchOnDescription: true, matchOnDetail: true },
  );
  if (picks && picks.length) await remove(picks.map((p) => p.job), refresh);
}

// ---------- running ----------

function tick(refresh) {
  try {
    const now = Date.now();
    for (const job of lib.loadJobs(store.jobs)) {
      if (job.status === 'pending' && job.at <= now) step(job, fire, refresh);
      if (job.status === 'queued' && queuedNeedsAction(job)) step(job, checkQueued, refresh);
    }
  } catch (e) {
    log(`✖ tick: ${e.stack || e}`);
  }
  refresh();
}

// Every state change runs under a lock keyed by the job's seq, held for the whole step, so it happens in exactly
// one window. seq is bumped before the lock is released: a window with a stale copy then fails the seq check.
function step(job, fn, refresh) {
  const seq = job.seq || 0;
  const key = `${job.id}-${seq}`;
  if (!lib.claim(store.locks, key)) return;
  const fresh = lib.loadJobs(store.jobs).find((j) => j.id === job.id);
  if (!fresh || (fresh.seq || 0) !== seq || fresh.status !== job.status) {
    lib.release(store.locks, key);
    return;
  }
  Promise.resolve()
    .then(() => fn(fresh, refresh))
    .catch((e) => log(`✖ ${e.stack || e}`))
    .finally(() => {
      lib.updateJob(store.jobs, job.id, { seq: seq + 1 });
      lib.release(store.locks, key);
      refresh();
    });
}

// Resuming a busy session from here would fork it: hand the message to its own process via the hook instead.
async function fire(job, refresh) {
  if (!job.file || !lib.isSessionBusy(job.file)) return runHeadless(job, refresh);
  if (lib.hookInstalled(hookCmd)) {
    lib.putInbox(store.inbox, job.sessionId, job.id, job.prompt);
    lib.updateJob(store.jobs, job.id, { status: 'queued', queuedAt: Date.now(), note: undefined });
    log(`✉ «${job.title}»: Claude работает — сообщение придёт в текущий ход`);
    return;
  }
  lib.updateJob(store.jobs, job.id, { at: Date.now() + BUSY_RETRY_MS, note: 'сессия работает, жду конца хода' });
  log(`⏸ «${job.title}»: Claude работает, хук не подключён — жду конца хода`);
  offerHookSetup();
}

function queuedNeedsAction(job) {
  const st = lib.inboxState(store.inbox, job.sessionId, job.id);
  return st !== 'waiting' || !job.file || !lib.isSessionBusy(job.file);
}

function checkQueued(job) {
  const st = lib.inboxState(store.inbox, job.sessionId, job.id);
  if (st === 'taken') {
    lib.clearInbox(store.inbox, job.sessionId, job.id);
    const saved = lib.updateJob(store.jobs, job.id, { status: 'done', finishedAt: Date.now(), result: 'доставлено в идущий ход' });
    log(`✔ «${job.title}»: доставлено в идущий ход`);
    if (saved) vscode.window.showInformationMessage(`Сообщение доставлено в «${saved.title}» во время работы Claude`);
    return;
  }
  // The turn ended without picking it up (hit the limit, panel closed...): take it back and resume in background.
  if (st === 'missing' || lib.withdrawInbox(store.inbox, job.sessionId, job.id)) {
    lib.clearInbox(store.inbox, job.sessionId, job.id);
    lib.updateJob(store.jobs, job.id, { status: 'pending', at: Date.now() });
    log(`↩ «${job.title}»: сессия освободилась — отправлю в фоне`);
  }
  // withdraw lost to the hook -> the next tick sees 'taken'
}

async function runHeadless(job, refresh) {
  const attempt = (job.attempts || 0) + 1;
  lib.updateJob(store.jobs, job.id, { status: 'running', attempts: attempt, startedAt: Date.now(), note: undefined });
  refresh();
  log(`▶ «${job.title}» (${job.sessionId}), попытка ${attempt}`);
  const verdict = lib.interpretRun(await runClaude(job));
  log(`${verdict.kind === 'done' ? '✔' : '✖'} ${verdict.kind}: ${verdict.text}`);
  await settle(job, attempt, verdict);
}

async function settle(job, attempt, { kind, text }) {
  if (kind === 'limit' && attempt < MAX_ATTEMPTS) {
    const at = lib.nextRetryAt(text, new Date(), config().get('retryMinutes'));
    if (lib.updateJob(store.jobs, job.id, { status: 'pending', at, lastError: text })) log(`⏳ лимит, повтор ${fmt(at)}`);
    return;
  }
  const done = kind === 'done';
  const saved = lib.updateJob(store.jobs, job.id, {
    status: done ? 'done' : 'failed',
    finishedAt: Date.now(),
    ...(done ? { result: text } : { lastError: text }),
  });
  if (!saved) return; // removed while running
  if (done) {
    // The open tab still shows the transcript it loaded before this run: reload it so the answer is visible.
    if (await reloadSessionTab(saved)) {
      vscode.window.showInformationMessage(`Claude продолжил «${saved.title}» — вкладка обновлена`);
    } else {
      vscode.window.showInformationMessage(`Claude продолжил «${saved.title}»`, 'Открыть сессию').then((b) => b && openSession(saved));
    }
  } else {
    vscode.window.showErrorMessage(`Не удалось продолжить «${saved.title}»: ${text.slice(0, 200)}`, 'Показать лог').then((b) => b && out.show());
  }
}

function runClaude(job) {
  const cfg = config();
  const args = ['--resume', job.sessionId, '-p', '--output-format', 'json', '--permission-mode', cfg.get('permissionMode')];
  const cwd = job.cwd && fs.existsSync(job.cwd) ? job.cwd : os.homedir();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      running.delete(job.id);
      resolve({ code, stdout, stderr });
    };
    const child = cp.spawn(claudeBinary(cfg), args, { cwd, windowsHide: true });
    running.set(job.id, child);
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      stderr += e.message;
      finish(-1);
    });
    child.on('close', finish);
    child.stdin.on('error', () => {}); // EPIPE when claude exits before reading the prompt
    child.stdin.end(job.prompt); // via stdin: no shell quoting of the user's text
  });
}

// Same binary as the Claude Code panel unless overridden.
function claudeBinary(cfg) {
  const custom = cfg.get('claudePath');
  if (custom) return custom;
  const ext = vscode.extensions.getExtension(CLAUDE_EXT_ID);
  const bundled = ext && path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return bundled && fs.existsSync(bundled) ? bundled : 'claude';
}

// An open tab of a session keeps the transcript it loaded; closing and reopening reloads it from disk.
// ponytail: tabs are matched by title (the Claude extension exposes no session id); no match -> nothing to reload.
async function reloadSessionTab(job) {
  const titles = [job.title];
  try {
    if (job.file) titles.push(lib.readSessionMeta(job.file).title);
  } catch {
    // transcript moved or deleted: fall back to the stored title
  }
  const stale = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(CLAUDE_PANEL_VIEWTYPE))
    .filter((t) => titles.some((title) => sameTitle(t.label, title)));
  if (!stale.length) return false;
  await vscode.window.tabGroups.close(stale);
  await vscode.commands.executeCommand('claude-vscode.editor.open', job.sessionId);
  return true;
}

async function openSession(job) {
  if (!(await reloadSessionTab(job))) await vscode.commands.executeCommand('claude-vscode.editor.open', job.sessionId);
}

// ---------- hook setup (the user edits ~/.claude/settings.json; the extension only reads it) ----------

function offerHookSetup() {
  if (hookOffered) return;
  hookOffered = true;
  vscode.window
    .showInformationMessage(
      'Сессия сейчас работает, поэтому сообщение ждёт конца хода. Чтобы оно приходило прямо в идущий ход, подключите хук Claude Code — одна вставка в ~/.claude/settings.json.',
      'Подключить',
    )
    .then((b) => b && showHookSetup());
}

async function showHookSetup() {
  if (lib.hookInstalled(hookCmd)) {
    vscode.window.showInformationMessage('Хук уже подключён: сообщения в работающие сессии приходят в идущий ход.');
    return;
  }
  const snippet = lib.hookSnippet(hookCmd);
  await vscode.env.clipboard.writeText(snippet);
  const doc = await vscode.workspace.openTextDocument({
    language: 'jsonc',
    content:
      '// Добавьте эти записи в раздел "hooks" файла ~/.claude/settings.json.\n' +
      '// Если там уже есть PostToolUse / Stop — допишите объекты в конец их массивов.\n' +
      '// Фрагмент уже в буфере обмена. Claude Code подхватит изменение сам, перезапуск не нужен.\n' +
      `${snippet}\n`,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
  const open = await vscode.window.showInformationMessage('Фрагмент хука скопирован в буфер обмена.', 'Открыть settings.json');
  if (open) await vscode.window.showTextDocument(vscode.Uri.file(lib.SETTINGS_FILE));
}

// ---------- view ----------

function sortJobs(jobs) {
  const active = jobs.filter((j) => ['pending', 'queued', 'running'].includes(j.status)).sort((a, b) => a.at - b.at);
  const finished = jobs.filter((j) => j.status === 'done' || j.status === 'failed').sort((a, b) => b.finishedAt - a.finishedAt);
  return [...active, ...finished];
}

function statusOf(job) {
  return STATUS[job.status] || STATUS.failed;
}

function jobItem(job) {
  const st = statusOf(job);
  const item = new vscode.TreeItem(job.title);
  item.description = st.text(job);
  item.iconPath = new vscode.ThemeIcon(st.icon);
  item.contextValue = `job-${job.status}`;
  item.command = { command: 'claudeScheduler.openSession', title: 'Открыть сессию', arguments: [job] };
  const tip = new vscode.MarkdownString();
  tip.appendMarkdown('**Сообщение:** ').appendText(job.prompt);
  tip.appendMarkdown('\n\n**Когда:** ').appendText(fmt(job.at));
  tip.appendMarkdown('\n\n**Сессия:** ').appendText(`${job.sessionId} · ${job.cwd || '?'}`);
  if (job.result) tip.appendMarkdown('\n\n**Ответ:** ').appendText(job.result);
  if (job.lastError) tip.appendMarkdown('\n\n**Последняя ошибка:** ').appendText(job.lastError);
  item.tooltip = tip;
  return item;
}

function updateStatus(status) {
  let jobs;
  try {
    jobs = lib.loadJobs(store.jobs);
  } catch {
    return status.hide();
  }
  const pending = jobs.filter((j) => j.status === 'pending').sort((a, b) => a.at - b.at);
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const busy = jobs.some((j) => j.status === 'running');
  if (!pending.length && !queued && !busy) return status.hide();
  const parts = [pending.length && `${pending.length} · ${fmt(pending[0].at)}`, queued && `✉ ${queued}`].filter(Boolean);
  status.text = `$(${busy ? 'sync~spin' : 'clock'}) ${parts.join('  ') || 'Claude продолжает…'}`;
  status.tooltip = 'Отложенные сообщения Claude';
  status.show();
}

// ---------- utils ----------

function config() {
  return vscode.workspace.getConfiguration('claudeScheduler');
}

function sameTitle(label, title) {
  if (!label || !title) return false;
  return label === title || (title.endsWith('…') && label.startsWith(title.slice(0, -1)));
}

function fmt(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`;
}

// "в 1 сессию / 3 сессии / 10 сессий"
function sessionsWord(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'сессию';
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 'сессии';
  return 'сессий';
}

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  if (min < 24 * 60) return `${Math.round(min / 60)} ч назад`;
  return `${Math.round(min / 1440)} дн назад`;
}

function log(msg) {
  out.appendLine(`[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`);
}

module.exports = { activate, deactivate };
