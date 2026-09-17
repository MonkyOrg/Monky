const { spawn } = require('node:child_process');
const [mode, runId] = process.argv.slice(2);
const timer = setInterval(() => {}, 1000);
let child;
if (mode === 'tree') {
  child = spawn(process.execPath, [__filename, 'idle', runId], { stdio: 'ignore', windowsHide: true });
  process.send({ type: 'qa-descendant', pid: child.pid });
}
if (mode === 'exit') process.exit(23);
if (mode !== 'no-ready') process.send?.({ type: 'qa-service-ready', value: { actualEvent: true } });
process.on('message', message => {
  if (message.runId !== runId) return;
  if (message.type === 'qa-ping') process.send({ type: 'qa-response', id: message.id, value: { alive: true } });
  if (message.type === 'qa-stop' && mode !== 'tree') { clearInterval(timer); process.exit(0); }
});
