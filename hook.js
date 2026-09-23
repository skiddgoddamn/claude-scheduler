// Claude Code hook (PostToolUse + Stop) for Claude Scheduler: `node hook.js <inboxDir>`.
// Delivers messages queued for the running session into its current turn,
// the same way a message typed while Claude works arrives mid-turn.
// Runs on every tool call of every session, so it must stay tiny and never fail loudly.
const fs = require('fs');
const path = require('path');

const INBOX = process.argv[2];
const PREFIX = 'Пользователь прислал сообщение, пока ты работал (отложенное, через Claude Scheduler). Учти его:';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    if (!INBOX || event.agent_id || !event.session_id) return; // subagent call: keep it for the main thread
    const dir = path.join(INBOX, path.basename(String(event.session_id)));
    if (!fs.existsSync(dir)) return;

    const texts = [];
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.msg')).sort()) {
      const taken = path.join(dir, name.replace(/\.msg$/, '.taken'));
      try {
        fs.renameSync(path.join(dir, name), taken); // atomic claim vs other hooks / the extension
      } catch {
        continue;
      }
      texts.push(fs.readFileSync(taken, 'utf8'));
    }
    if (!texts.length) return;

    const text = `${PREFIX}\n\n${texts.join('\n\n---\n\n')}`;
    const out =
      event.hook_event_name === 'Stop'
        ? { decision: 'block', reason: text }
        : { hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: text } };
    process.stdout.write(JSON.stringify(out));
  } catch {
    // never break the user's session because of the scheduler
  }
});
