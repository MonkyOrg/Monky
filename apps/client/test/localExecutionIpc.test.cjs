const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { test } = require('node:test');
const ts = require('typescript');
const shared = require('@monky/shared');

function fixture() {
  const handlers = new Map();
  const removed = [];
  const sent = [];
  const calls = [];
  const warnings = [];
  let destroyed = false;
  let state = { supported: true, tools: [], permissions: [], tasks: [], toolsBytes: 0, cacheBytes: 0 };
  let snapshot = async () => state;
  let dispose = async () => undefined;
  const contents = new EventEmitter();
  contents.id = 8;
  contents.mainFrame = {};
  contents.isDestroyed = () => destroyed;
  contents.send = (channel, value) => { sent.push({ channel, value }); contents.emit('sent'); };
  const window = {
    isDestroyed: () => destroyed,
    get webContents() {
      if (destroyed) throw new Error('Destroyed BrowserWindow.webContents must not be read');
      return contents;
    },
  };
  const sourceDirectory = path.join(__dirname, '..', 'src', 'main', 'localExecution');
  const source = fs.readFileSync(path.join(sourceDirectory, 'ipc.ts'), 'utf8');
  const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
  const compiled = ts.transpileModule(source, {
    compilerOptions,
  }).outputText;
  const errors = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(sourceDirectory, 'errors.ts'), 'utf8'), {
    compilerOptions,
  }).outputText, { module: errors, exports: errors.exports }, { filename: 'local-execution-errors.cjs' });
  const module = { exports: {} };
  const load = (name) => {
    if (name === 'electron') return { ipcMain: {
      handle(channel, handler) {
        assert.equal(handlers.has(channel), false, 'Each handler must have one owner.');
        handlers.set(channel, handler);
      },
      removeHandler(channel) { removed.push(channel); handlers.delete(channel); },
    } };
    if (name === '@monky/shared') return shared;
    if (name === '../i18n') return { mt: (key) => key };
    if (name === './errors') return errors.exports;
    throw new Error(`Unexpected IPC fixture import: ${name}`);
  };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require: load, setTimeout, clearTimeout,
    console: { warn: (...args) => warnings.push(args) },
  }, { filename: 'local-execution-ipc.cjs' });
  const service = {
    snapshot: async () => { calls.push(['snapshot']); return snapshot(); },
    cancelOwner: async () => { calls.push(['cancelOwner']); },
    dispose: async () => { calls.push(['dispose']); return dispose(); },
  };
  for (const method of [
    'setPermission', 'removeTool', 'clearCache', 'cancelTask', 'prepare', 'startTask',
    'readFrames', 'acknowledgeFrames', 'cancelRequest', 'setPaused', 'setConnection',
  ]) {
    service[method] = async (input) => { calls.push([method, input]); return { status: 'completed' }; };
  }
  let notifications;
  const lifecycle = module.exports.setupLocalExecutionIpc(window, (events) => { notifications = events; return service; });
  const owner = { sender: contents, senderFrame: contents.mainFrame };
  return {
    handlers, removed, sent, calls, warnings, contents, lifecycle, notifications, owner, service,
    LocalExecutionError: errors.exports.LocalExecutionError,
    setSnapshot: (fn) => { snapshot = fn; },
    setDispose: (fn) => { dispose = fn; },
    destroy: () => { destroyed = true; contents.emit('destroyed'); },
  };
}

test('only the exact owning top-level frame can read state or execute local IPC actions', async (t) => {
  const f = fixture();
  t.after(() => f.lifecycle.dispose());
  assert.equal(f.handlers.size, Object.keys(shared.LOCAL_EXECUTION_IPC).length);
  const subframe = { ...f.owner, senderFrame: {} };
  await assert.rejects(f.handlers.get(shared.LOCAL_EXECUTION_IPC.getState)(subframe), /invalidOwner/);
  for (const channel of Object.values(shared.LOCAL_EXECUTION_IPC)) {
    if (channel === shared.LOCAL_EXECUTION_IPC.getState) continue;
    const result = await f.handlers.get(channel)(subframe, { untrusted: true });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'invalid_request');
  }
  assert.equal(f.calls.length, 0);
  const state = await f.handlers.get(shared.LOCAL_EXECUTION_IPC.getState)(f.owner);
  assert.equal(state.supported, true);
  const input = { requestId: 'owned' };
  await f.handlers.get(shared.LOCAL_EXECUTION_IPC.prepare)(f.owner, input);
  assert.deepEqual(f.calls.at(-1), ['prepare', input]);
});

test('subframe navigation does not stop audio; full owner navigation and renderer loss do', async (t) => {
  const f = fixture();
  t.after(() => f.lifecycle.dispose());
  f.contents.emit('did-start-navigation', {}, 'about:blank', false, false);
  f.contents.emit('did-start-navigation', {}, 'file:///app#section', true, true);
  assert.equal(f.calls.length, 0);
  f.contents.emit('did-start-navigation', {}, 'file:///app', false, true);
  f.contents.emit('render-process-gone', {}, {});
  assert.equal(f.calls.filter(([method]) => method === 'cancelOwner').length, 2);
});

test('owned IPC preserves safe source failures in replies and notifications without native diagnostics', async (t) => {
  const f = fixture();
  t.after(() => f.lifecycle.dispose());
  const sourceFailure = { code: 'recovery_failed', attempts: 5 };
  f.service.readFrames = async () => {
    throw new f.LocalExecutionError('provider_unavailable', {
      sourceFailure, cause: new Error('Private native diagnostic'),
    });
  };
  const result = await f.handlers.get(shared.LOCAL_EXECUTION_IPC.readFrames)(f.owner, { taskId: 'task', count: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 'failed', reason: 'provider_unavailable', sourceFailure });
  const failure = { taskId: 'task', reason: 'provider_unavailable', sourceFailure };
  f.notifications.failed(failure);
  assert.deepEqual(f.sent, [{ channel: shared.LOCAL_EXECUTION_TASK_FAILED, value: failure }]);
  assert.equal(f.warnings.length, 1, 'Unexpected native failures must still be logged locally');
});

test('state publication is coalesced and a late read cannot publish after disposal', { timeout: 3000 }, async (t) => {
  const f = fixture();
  t.after(() => f.lifecycle.dispose());
  const published = once(f.contents, 'sent');
  f.notifications.changed();
  f.notifications.changed();
  f.notifications.changed();
  await published;
  assert.equal(f.calls.filter(([method]) => method === 'snapshot').length, 1);
  assert.equal(f.sent[0].channel, shared.LOCAL_EXECUTION_CHANGED);
  let resolveRead;
  let readStarted;
  const pending = new Promise((resolve) => { resolveRead = resolve; });
  const started = new Promise((resolve) => { readStarted = resolve; });
  f.setSnapshot(async () => { readStarted(); return pending; });
  f.notifications.changed();
  await started;
  await f.lifecycle.dispose();
  resolveRead({ supported: false, tools: [], permissions: [], tasks: [], toolsBytes: 0, cacheBytes: 0 });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(f.sent.length, 1);
  f.notifications.failed({ taskId: 'late', reason: 'cancelled' });
  assert.equal(f.sent.length, 1);
  assert.equal(f.handlers.size, 0);
});

test('destruction and cleanup retries do not touch a dead window or unregister later owners twice', async () => {
  const f = fixture();
  let failures = 1;
  f.setDispose(async () => { if (failures--) throw new Error('Controlled cleanup failure'); });
  f.destroy();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(f.handlers.size, 0);
  const count = f.removed.length;
  await f.lifecycle.dispose();
  assert.equal(f.removed.length, count, 'A retry must not remove handlers belonging to a new owner.');
  assert.equal(f.contents.listenerCount('did-start-navigation'), 0);
  assert.equal(f.contents.listenerCount('render-process-gone'), 0);
});
