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

test('shutdown freezes new local work without removing connection, cancellation or acknowledgement IPC', async t => {
  const f = fixture();
  t.after(() => f.lifecycle.dispose());
  f.lifecycle.freezeAdmissions();
  for (const name of ['prepare', 'startTask', 'setPermission', 'removeTool', 'clearCache']) {
    const result = await f.handlers.get(shared.LOCAL_EXECUTION_IPC[name])(f.owner, {});
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'executor_unavailable');
  }
  assert.equal(f.calls.length, 0);
  for (const name of ['setConnection', 'cancelTask', 'cancelRequest', 'acknowledgeFrames']) {
    const result = await f.handlers.get(shared.LOCAL_EXECUTION_IPC[name])(f.owner, {});
    assert.equal(result.status, 'completed');
  }
  assert.equal(f.handlers.size, Object.keys(shared.LOCAL_EXECUTION_IPC).length);
});

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

const shutdownTick = () => new Promise(resolve => setImmediate(resolve));
const shutdownDeferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

function rendererMethod(relativeFile, name, bindings) {
  const filename = path.resolve(__dirname, '..', 'src', 'renderer', relativeFile);
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const method = source.statements.filter(ts.isClassDeclaration).flatMap(node => [...node.members])
    .find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  assert.ok(method);
  const compiled = ts.transpileModule(`class Owner { ${method.getText(source)} }\nmodule.exports = Owner;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, ...bindings }, { filename });
  return new module.exports();
}

test('renderer farewell awaits native cleanup and each real controller synchronization before disconnect and acknowledgement', async () => {
  const phases = [], native = shutdownDeferred(), background = shutdownDeferred(), active = shutdownDeferred();
  const clientLog = { info() {}, error: () => assert.fail('Farewell unexpectedly failed') };
  const sessions = [background, active].map((gate, index) => {
    const controller = rendererMethod(path.join('core', 'LocalExecutionController.ts'), 'dispose', {
      controllers: new Map(),
    });
    Object.assign(controller, {
      disposed: false, client: {}, unbind: [], nativeUpdate: gate.promise,
      invalidateConnection: () => phases.push(`synchronize-${index}`),
    });
    return { key: String(index), localExecution: controller };
  });
  const manager = rendererMethod(path.join('core', 'SessionManager.ts'), 'removeAll', { clientLog });
  Object.assign(manager, {
    sessions: new Map(sessions.map(session => [session.key, session])),
    getBackground: () => [sessions[0]], getActive: () => sessions[1],
    remove: key => phases.push(`disconnect-${key}`),
  });
  let beforeQuit;
  const app = rendererMethod('main.ts', 'setupGracefulQuit', {
    clientLog, sessionManager: manager,
    webRtcManager: { prepareForQuit: () => native.promise },
    window: { api: {
      onAppBeforeQuit: callback => { beforeQuit = callback; },
      notifyLeaveComplete: async () => { phases.push('acknowledge'); },
    } },
  });
  app.setupGracefulQuit();
  beforeQuit({ requestId: 1, phase: 'farewell' });
  await shutdownTick();
  assert.deepEqual(phases, []);
  native.resolve();
  await shutdownTick();
  assert.deepEqual(phases, ['synchronize-0']);
  background.resolve();
  await shutdownTick();
  assert.deepEqual(phases, ['synchronize-0', 'disconnect-0', 'synchronize-1']);
  active.resolve();
  await shutdownTick();
  assert.deepEqual(phases, ['synchronize-0', 'disconnect-0', 'synchronize-1', 'disconnect-1', 'acknowledge']);
});

test('renderer cleanup failure never acknowledges a successful farewell or disconnects the servers', async () => {
  const errors = [];
  let beforeQuit;
  const app = rendererMethod('main.ts', 'setupGracefulQuit', {
    clientLog: { error: (...values) => errors.push(values) },
    webRtcManager: { prepareForQuit: async () => { throw new Error('Renderer presentation lease retained'); } },
    sessionManager: { removeAll: () => assert.fail('The connection must remain live') },
    window: { api: {
      onAppBeforeQuit: callback => { beforeQuit = callback; },
      notifyLeaveComplete: () => assert.fail('Retained ownership must not be acknowledged'),
    } },
  });
  app.setupGracefulQuit();
  beforeQuit({ requestId: 1, phase: 'farewell' });
  await shutdownTick();
  assert.equal(errors.length, 1);
});

test('native-only renderer phase echoes its exact request without disconnecting sessions', async () => {
  const native = shutdownDeferred(), replies = [];
  let beforeQuit;
  const app = rendererMethod('main.ts', 'setupGracefulQuit', {
    clientLog: { error: () => assert.fail('Native preparation failed') },
    webRtcManager: { prepareForQuit: () => native.promise },
    sessionManager: { removeAll: () => assert.fail('Native preparation must retain signaling') },
    window: { api: {
      onAppBeforeQuit: callback => { beforeQuit = callback; },
      notifyLeaveComplete: async request => replies.push(request),
    } },
  });
  app.setupGracefulQuit();
  const request = { requestId: 41, phase: 'native' };
  beforeQuit(request);
  await shutdownTick();
  assert.deepEqual(replies, []);
  native.resolve();
  await shutdownTick();
  assert.deepEqual(replies, [request]);
});

function shutdownFixture(dispose, { prepare = async () => {}, farewell = false, nativeHandshake = false } = {}) {
  const filename = path.resolve(__dirname, '..', 'src', 'main', 'main.ts');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set(['stopLocalExecutionThenQuit', 'quitApplication', 'announceLeave', 'requestRendererShutdown']);
  const selected = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
  assert.equal(selected.length, names.size);
  const beforeQuit = source.statements.find(node => ts.isExpressionStatement(node)
    && node.getText(source).startsWith("app.on('before-quit'"));
  assert.ok(beforeQuit);
  selected.push(beforeQuit);
  const compiled = ts.transpileModule(selected.map(node => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const choices = [], errors = [], phases = [], requests = [], warnings = [];
  let beforeQuitHandler;
  let attempts = 0, exited = 0;
  const context = vm.createContext({
    localExecution: {
      freezeAdmissions() {},
      prepareShutdown: prepare,
      async dispose() { phases.push('local-dispose'); attempts++; return dispose(attempts); },
    },
    localExecutionStopping: false, localExecutionStopped: false, isQuitting: true, leaveAnnounced: !farewell,
    rendererNativeRetired: !nativeHandshake, shutdownRequestId: 0, APP_SHUTDOWN_EVENT: shared.APP_SHUTDOWN_EVENT,
    onLeaveComplete: null, LEAVE_ANNOUNCE_TIMEOUT_MS: 15000, setTimeout, clearTimeout,
    mainWindow: { isDestroyed: () => false, show() {},
      webContents: { send: (channel, request) => {
        assert.equal(channel, shared.APP_SHUTDOWN_EVENT);
        requests.push(request); phases.push(request.phase === 'native' ? 'native-handshake' : 'farewell');
      } } },
    crashRecovery: null, clientLogger: null, trayManager: null, overlayManager: null, shutdownServer() {},
    mt: key => key,
    console: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
    dialog: { showMessageBox() { const choice = shutdownDeferred(); choices.push(choice); return choice.promise; } },
    app: {
      on(name, callback) { assert.equal(name, 'before-quit'); beforeQuitHandler = callback; },
      quit() {
        let prevented = false;
        beforeQuitHandler({ preventDefault() { prevented = true; } });
        if (!prevented) { phases.push('window-close'); exited++; }
      },
    },
  });
  vm.runInContext(compiled, context, { filename });
  return { context, choices, errors, phases, requests, warnings,
    acknowledge: () => context.onLeaveComplete(requests.at(-1)), attempts: () => attempts, exited: () => exited };
}

test('real before-quit drains native ownership before farewell, local disposal and final window closure', async () => {
  const native = shutdownDeferred(), local = shutdownDeferred();
  const f = shutdownFixture(() => local.promise, { farewell: true, prepare: async () => {
    f.phases.push('native-drain'); await native.promise; f.phases.push('native-retired');
  } });
  f.context.quitApplication();
  await shutdownTick();
  assert.deepEqual(f.phases, ['native-drain']);
  f.context.quitApplication();
  native.resolve();
  await shutdownTick();
  assert.deepEqual(f.phases, ['native-drain', 'native-retired', 'farewell']);
  assert.equal(f.attempts(), 0, 'IPC remains live until the renderer acknowledges its awaited farewell.');
  f.acknowledge();
  await shutdownTick();
  assert.equal(f.phases.at(-1), 'local-dispose');
  assert.equal(f.exited(), 0);
  local.resolve();
  await shutdownTick();
  assert.deepEqual(f.phases, ['native-drain', 'native-retired', 'farewell', 'local-dispose', 'window-close']);
});

test('native renderer quiescence precedes global drain and phase-mismatched acknowledgements cannot advance shutdown', async () => {
  const f = shutdownFixture(async () => {}, {
    nativeHandshake: true, farewell: true, prepare: async () => { f.phases.push('global-drain'); },
  });
  f.context.quitApplication();
  await shutdownTick();
  assert.deepEqual(f.phases, ['native-handshake']);
  const native = f.requests[0];
  f.context.onLeaveComplete({ ...native, phase: 'farewell' });
  await shutdownTick();
  assert.equal(f.context.rendererNativeRetired, false);
  f.acknowledge();
  await shutdownTick();
  assert.deepEqual(f.phases, ['native-handshake', 'global-drain', 'farewell']);
  f.context.onLeaveComplete(native);
  await shutdownTick();
  assert.equal(f.attempts(), 0);
  f.acknowledge();
  await shutdownTick();
  assert.equal(f.exited(), 1);
  assert.equal(f.warnings.length, 2);
});

test('an expired native-phase acknowledgement cannot complete the next Retry attempt', async () => {
  const f = shutdownFixture(async () => {}, { nativeHandshake: true });
  let expire;
  f.context.setTimeout = callback => { expire = callback; return 1; };
  f.context.clearTimeout = () => {};
  f.context.quitApplication();
  await shutdownTick();
  const stale = f.requests[0];
  expire();
  await shutdownTick();
  assert.equal(f.context.rendererNativeRetired, false);
  f.choices[0].resolve({ response: 0 });
  await shutdownTick();
  assert.notEqual(stale.requestId, f.requests[1].requestId);
  f.context.onLeaveComplete(stale);
  await shutdownTick();
  assert.equal(f.exited(), 0);
  assert.equal(f.attempts(), 0);
  f.acknowledge();
  await shutdownTick();
  assert.equal(f.exited(), 1);
});

test('failed native drain keeps the connection alive for Retry; completed farewell is not replayed', async () => {
  let nativeAttempts = 0, nativeRetired = false;
  const f = shutdownFixture(async attempt => { if (attempt === 1) throw new Error('Local worker not yet retired'); }, {
    farewell: true, prepare: async () => {
      if (nativeRetired) return;
      if (++nativeAttempts === 1) throw new Error('Retained PCM/GPU owner');
      nativeRetired = true;
    },
  });
  f.context.quitApplication();
  await shutdownTick();
  assert.deepEqual(f.phases, []);
  assert.equal(f.context.leaveAnnounced, false);
  f.choices[0].resolve({ response: 0 });
  await shutdownTick();
  assert.deepEqual(f.phases, ['farewell']);
  f.acknowledge();
  await shutdownTick();
  assert.equal(f.choices.length, 2);
  assert.equal(f.context.leaveAnnounced, true);
  f.choices[1].resolve({ response: 0 });
  await shutdownTick();
  assert.equal(nativeAttempts, 2);
  assert.deepEqual(f.phases, ['farewell', 'local-dispose', 'local-dispose', 'window-close']);
});

test('missing renderer acknowledgement fails closed and Retry waits for a fresh completed handshake', async () => {
  const f = shutdownFixture(async () => {}, { farewell: true });
  let expire;
  f.context.setTimeout = callback => { expire = callback; return 1; };
  f.context.clearTimeout = () => {};
  f.context.quitApplication();
  await shutdownTick();
  expire();
  await shutdownTick();
  assert.equal(f.attempts(), 0);
  assert.equal(f.exited(), 0);
  assert.equal(f.context.leaveAnnounced, false);
  assert.equal(f.context.onLeaveComplete, null);
  f.choices[0].resolve({ response: 0 });
  await shutdownTick();
  assert.equal(f.exited(), 0);
  f.acknowledge();
  await shutdownTick();
  assert.equal(f.exited(), 1);
});

test('application shutdown serializes its failure dialog and Retry waits for real resource disposal', async () => {
  const retirement = shutdownDeferred();
  const f = shutdownFixture(async attempt => {
    if (attempt === 1) throw new Error('Native ownership remains unresolved');
    await retirement.promise;
  });
  f.context.stopLocalExecutionThenQuit();
  await shutdownTick();
  assert.equal(f.choices.length, 1);
  assert.equal(f.exited(), 0);
  f.context.stopLocalExecutionThenQuit();
  await shutdownTick();
  assert.equal(f.attempts(), 1, 'Window/tray quit cannot overlap an unresolved failure dialog.');
  f.choices[0].resolve({ response: 0 });
  await shutdownTick();
  assert.equal(f.attempts(), 2);
  assert.equal(f.exited(), 0, 'Retry cannot bypass pending native retirement.');
  retirement.resolve();
  await shutdownTick();
  assert.equal(f.exited(), 1);
  assert.equal(f.context.localExecutionStopped, true);
  assert.equal(f.errors.length, 1);
});

test('Keep open preserves the app and a later quit can attempt native disposal again', async () => {
  const f = shutdownFixture(async attempt => { if (attempt === 1) throw new Error('Retained native owner'); });
  f.context.stopLocalExecutionThenQuit();
  await shutdownTick();
  f.choices[0].resolve({ response: 1 });
  await shutdownTick();
  assert.equal(f.exited(), 0);
  assert.equal(f.context.localExecutionStopped, false);
  assert.equal(f.context.localExecutionStopping, false);
  assert.equal(f.context.isQuitting, false);
  f.context.stopLocalExecutionThenQuit();
  await shutdownTick();
  assert.equal(f.exited(), 1);
  assert.equal(f.attempts(), 2);
});

test('a failed shutdown dialog cannot permanently latch the app-close guard', async () => {
  const f = shutdownFixture(async attempt => { if (attempt === 1) throw new Error('Retained native owner'); });
  f.context.dialog.showMessageBox = () => { throw new Error('Dialog could not open'); };
  f.context.stopLocalExecutionThenQuit();
  await shutdownTick();
  assert.equal(f.context.localExecutionStopping, false);
  assert.equal(f.context.localExecutionStopped, false);
  assert.equal(f.exited(), 0);
  assert.equal(f.errors.length, 2);
  f.context.stopLocalExecutionThenQuit();
  await shutdownTick();
  assert.equal(f.exited(), 1);
});
