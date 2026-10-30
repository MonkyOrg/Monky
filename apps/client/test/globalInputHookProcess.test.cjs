'use strict';

// The Windows shortcut observer runs in a utility process; a modeled fork and clock make its
// restart policy deterministic without Electron, uiohook or real time.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const ts = require('typescript');

const sourceFile = path.resolve(__dirname, '..', 'src', 'main', 'globalInputHookProcess.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const configuration = {
  actions: [{ action: 'toggle_mute', accelerator: 'F23' }], sounds: [],
  ptt: { enabled: false, key: null }, pttCapture: false, shortcutCapture: false,
};

function fixture() {
  let now = 0;
  const timers = [], children = [], sent = [];
  const electron = { utilityProcess: { fork() {
    const child = Object.assign(new EventEmitter(), {
      messages: [], postMessage(message) { this.messages.push(message); }, kill() { this.emit('exit', 1); return true; },
    });
    children.push(child);
    return child;
  } } };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, __dirname: path.dirname(sourceFile),
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'path') return path;
      if (name === './globalInputHook') return { globalInputHook: {} };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { platform: 'win32' }, Date: { now: () => now }, console: { warn() {} },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false, unref: () => timer };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  }, { filename: sourceFile });
  const window = { isDestroyed: () => false, webContents: { send: (channel, ...args) => sent.push([channel, ...args]) } };
  const hook = new module.exports.GlobalInputHookProcess();
  const latest = () => children.at(-1);
  const ready = () => { latest().emit('spawn'); latest().emit('message', { type: 'ready' }); };
  /** Applies one shortcut change so the worker has a configuration worth restoring after a crash. */
  const configure = async () => {
    const result = hook.setActionHotkeys(configuration.actions);
    await flush();
    const request = latest().messages.find(message => message.type === 'request');
    latest().emit('message', { type: 'result', id: request.id, ok: true, configuration });
    assert.equal(await result, true);
  };
  /** Crashes the current worker and returns the delay of the restart it schedules. */
  const crash = () => {
    const before = timers.length;
    latest().emit('exit', 1);
    const scheduled = timers.slice(before);
    assert.equal(scheduled.length, 1, 'Each crash schedules exactly one restart.');
    return scheduled[0];
  };
  return { hook, window, children, sent, timers, ready, configure, crash, advance: ms => { now += ms; } };
}

test('a worker that keeps crashing restarts with exponential backoff capped at one minute', async () => {
  const f = fixture();
  f.hook.init(f.window);
  f.ready();
  await f.configure();
  const delays = [];
  for (let attempt = 0; attempt < 9; attempt++) {
    const restart = f.crash();
    delays.push(restart.delay);
    restart.callback();
    assert.equal(f.children.length, attempt + 2, 'The scheduled restart forks one replacement.');
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(f.children.at(-1).messages[0], undefined, 'The replacement waits for its own spawn.');
  f.children.at(-1).emit('spawn');
  assert.equal(f.children.at(-1).messages[0].type, 'init');
  assert.equal(f.children.at(-1).messages[0].configuration, configuration, 'Every restart restores the last accepted setup.');
  assert.ok(f.sent.filter(([channel, active]) => channel === 'ptt:state-changed' && active === false).length >= 9);
  f.hook.destroy();
});

test('healthy uptime resets the backoff, and an explicit change restarts at once', async () => {
  const f = fixture();
  f.hook.init(f.window);
  f.ready();
  await f.configure();
  for (const expected of [1000, 2000, 4000]) {
    const restart = f.crash();
    assert.equal(restart.delay, expected);
    restart.callback();
  }
  f.ready();
  f.advance(30_000);
  const afterStableRun = f.crash();
  assert.equal(afterStableRun.delay, 1000, 'A crash after 30 s of uptime is a new incident.');
  const forks = f.children.length;
  const change = f.hook.setShortcutCapture(false);
  assert.equal(afterStableRun.cleared, true, 'A user change does not wait for the backoff.');
  assert.equal(f.children.length, forks + 1);
  f.ready();
  await flush();
  const request = f.children.at(-1).messages.find(message => message.type === 'request');
  f.children.at(-1).emit('message', { type: 'result', id: request.id, ok: true, configuration });
  assert.equal(await change, true);
  f.hook.destroy();
});

test('destroy cancels a pending restart and a new window starts without inherited backoff', async () => {
  const f = fixture();
  f.hook.init(f.window);
  f.ready();
  await f.configure();
  for (let attempt = 0; attempt < 4; attempt++) f.crash().callback();
  const pending = f.crash();
  assert.equal(pending.delay, 16000);
  f.hook.destroy();
  assert.equal(pending.cleared, true);
  const forks = f.children.length;
  f.hook.init(f.window);
  assert.equal(f.children.length, forks + 1);
  f.ready();
  await f.configure();
  assert.equal(f.crash().delay, 1000);
  f.hook.destroy();
});
