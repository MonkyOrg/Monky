const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { LIMITS } = require('@monky/shared');

const mainRoot = path.resolve(__dirname, '..', 'src', 'main');
const serverA = { port: 3000, serverName: 'A', serverId: 'a' };
const serverB = { port: 3001, serverName: 'B', serverId: 'b' };
const stopped = { isRunning: false, port: null, serverId: null };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function runtime() {
  return {
    starts: 0, stops: 0,
    onStart: async () => {},
    onStop: async () => {},
    async start() { this.starts++; await this.onStart(); },
    async stop() { this.stops++; await this.onStop(); },
    async getStats() { return { serverName: 'Synthetic server' }; },
  };
}

function fixture(create) {
  const configCalls = [];
  const events = [];
  const errors = [];
  const logListeners = new Set();
  const io = { directories: [], removed: [], renamed: [], existing: new Set(), failure: null };
  const fakeFs = {
    existsSync: name => io.existing.has(name),
    mkdirSync(name) {
      io.directories.push(name);
      if (io.failure) throw io.failure;
    },
    renameSync: (from, to) => { io.renamed.push([from, to]); },
    rmSync: name => { io.removed.push(name); },
  };
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, ...args) => events.push({ channel, args: structuredClone(args) }),
    },
  };
  const dependencies = new Map([
    ['path', path], ['fs', fakeFs],
    ['electron', {
      app: { getPath: () => path.join('C:\\', 'synthetic-monky-profile') },
      BrowserWindow: {
        getAllWindows: () => [
          fakeWindow,
          { isDestroyed: () => true, webContents: { send: () => assert.fail('Destroyed window must be skipped') } },
          { isDestroyed: () => false, webContents: { isDestroyed: () => true, send: () => assert.fail('Destroyed renderer must be skipped') } },
        ],
      },
    }],
    ['@monky/shared', { LIMITS }],
    ['@monky/server', {
      MonkyServer: { create: async config => { configCalls.push({ ...config }); return create(config); } },
      Logger: {
        subscribe: callback => { logListeners.add(callback); return () => logListeners.delete(callback); },
        getRecent: () => [],
        clearBuffer: () => {},
      },
    }],
  ]);
  const modules = new Map();
  const localModules = new Set(['serverManager', 'hostedServerLifecycle', 'i18n', 'serverDataDir']);
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    assert.ok(localModules.has(name), `Unexpected native module: ${name}`);
    const filename = path.join(mainRoot, `${name}.ts`);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      fileName: filename,
    }).outputText;
    const module = { exports: {} };
    modules.set(name, module.exports);
    // Only these synthetic dependencies are available. No Electron app, actual
    // MonkyServer instance or real filesystem mutation can escape the fixture.
    vm.runInNewContext(code, {
      module, exports: module.exports, Error, Promise,
      console: { log: () => {}, error: (...args) => errors.push(args) },
      require(request) {
        if (dependencies.has(request)) return dependencies.get(request);
        if (request.startsWith('./')) return load(request.slice(2));
        throw new Error(`Unexpected native dependency: ${request}`);
      },
    }, { filename });
    return module.exports;
  }
  const { ServerManager } = load('serverManager');
  return { manager: new ServerManager(), i18n: load('i18n'), configCalls, events, errors, io, logListeners };
}

test('real ServerManager wiring serializes concurrent IPC starts and never replaces a hosted identity', async () => {
  const gate = deferred();
  const server = runtime();
  server.onStart = () => gate.promise;
  const f = fixture(async () => server);
  const first = f.manager.startServer({ ...serverA, voiceMode: 'sfu', maxUsers: 8 });
  const duplicate = f.manager.startServer({ ...serverA });
  const competing = f.manager.startServer({ ...serverB, port: serverA.port });
  const otherPort = f.manager.startServer({ ...serverA, port: 3002 });
  await flush();
  assert.equal(f.configCalls.length, 1);
  assert.equal(f.configCalls[0].voiceMode, 'sfu');
  assert.equal(f.configCalls[0].maxUsers, 8);
  assert.equal(f.configCalls[0].dataDir, path.join('C:\\', 'synthetic-monky-profile', 'server-data', 'a'));
  assert.equal(server.starts, 1);
  assert.equal(server.stops, 0);
  assert.deepEqual({ ...f.manager.getStatus() }, stopped);
  gate.resolve();
  const results = await Promise.all([first, duplicate, competing, otherPort]);
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, true);
  assert.equal(results[2].error, f.i18n.mt('error.hostedServerAlreadyRunning'));
  assert.equal(results[3].success, false);
  assert.equal(f.io.directories.length, 1);
  assert.equal(f.configCalls.length, 1);
  assert.equal(server.stops, 0);
  assert.equal(f.logListeners.size, 1);
  assert.deepEqual({ ...f.manager.getStatus() }, { isRunning: true, port: 3000, serverId: 'a' });
  assert.deepEqual(f.events, [{
    channel: 'server-host:status-changed',
    args: [{ isRunning: true, port: 3000, serverId: 'a' }],
  }]);
});

test('legacy data cannot be relabeled by a same-port caller and conflict errors follow native language', async () => {
  const server = runtime();
  const f = fixture(async () => server);
  await f.manager.startServer({ port: 3000, serverName: 'Legacy' });
  f.i18n.setMainLanguage('en');
  const conflict = await f.manager.startServer(serverA);
  assert.equal(conflict.success, false);
  assert.match(conflict.error, /^Another server is already running/);
  assert.deepEqual({ ...f.manager.getStatus() }, { isRunning: true, port: 3000, serverId: null });
  assert.equal(server.stops, 0);
  assert.equal(f.configCalls.length, 1);
  assert.equal((await f.manager.startServer({ port: 3000, serverName: 'Legacy duplicate' })).success, true);
  await f.manager.stopServer();
  await f.manager.startServer(serverA);
  assert.equal((await f.manager.startServer({ port: 3000, serverName: 'Unknown' })).success, false);
  assert.equal(f.manager.getStatus().serverId, 'a');
});

test('stop queued during creation and duplicate stops finish before another host is created', async () => {
  const creation = deferred();
  const stopping = deferred();
  const firstServer = runtime();
  const secondServer = runtime();
  firstServer.onStop = () => stopping.promise;
  const f = fixture(async config => {
    if (config.port !== 3000) return secondServer;
    await creation.promise;
    return firstServer;
  });
  const first = f.manager.startServer(serverA);
  const stop = f.manager.stopServer();
  const duplicateStop = f.manager.stopServer();
  const next = f.manager.startServer(serverB);
  await flush();
  assert.equal(f.configCalls.length, 1);
  assert.equal(firstServer.stops, 0);
  creation.resolve();
  assert.equal((await first).success, true);
  await flush();
  assert.equal(firstServer.stops, 1);
  assert.equal(f.logListeners.size, 1);
  assert.equal(f.configCalls.length, 1);
  assert.equal(f.manager.getStatus().isRunning, true);
  stopping.resolve();
  await Promise.all([stop, duplicateStop]);
  assert.equal((await next).success, true);
  assert.equal(firstServer.stops, 1);
  assert.equal(secondServer.starts, 1);
  assert.equal(f.logListeners.size, 1);
  assert.deepEqual(f.events.filter(event => event.channel === 'server-host:status-changed').map(event => event.args[0]), [
    { isRunning: true, port: 3000, serverId: 'a' }, stopped,
    { isRunning: true, port: 3001, serverId: 'b' },
  ]);
});

test('filesystem and runtime start failures return explicit errors and permit retry without orphaning a candidate', async () => {
  const broken = runtime();
  const healthy = runtime();
  broken.onStart = async () => { throw new Error('Synthetic bind failure'); };
  let attempts = 0;
  const f = fixture(async () => ++attempts === 1 ? broken : healthy);
  f.io.failure = new Error('Synthetic directory failure');
  assert.equal((await f.manager.startServer(serverA)).error, 'Synthetic directory failure');
  assert.equal(f.configCalls.length, 0);
  assert.deepEqual({ ...f.manager.getStatus() }, stopped);
  f.io.failure = null;
  assert.equal((await f.manager.startServer(serverA)).error, 'Synthetic bind failure');
  assert.equal(broken.stops, 1);
  assert.equal(f.logListeners.size, 0);
  assert.deepEqual({ ...f.manager.getStatus() }, stopped);
  assert.equal((await f.manager.startServer(serverA)).success, true);
  assert.equal(healthy.starts, 1);
  assert.equal(healthy.stops, 0);
  assert.equal(f.configCalls.length, 2);
});

test('stop failure keeps real manager identity, stats and log forwarding until shutdown is acknowledged', async () => {
  const server = runtime();
  const f = fixture(async () => server);
  await f.manager.startServer(serverA);
  server.onStop = async () => { throw new Error('Synthetic shutdown failure'); };
  await assert.rejects(f.manager.stopServer(), /Synthetic shutdown failure/);
  assert.equal(f.manager.getStatus().serverId, 'a');
  assert.equal(f.manager.getStatus().isRunning, true);
  assert.equal((await f.manager.getStats()).serverName, 'Synthetic server');
  assert.equal(f.logListeners.size, 1);
  for (const listener of f.logListeners) listener({ message: 'Still owned after failed stop' });
  assert.equal(f.events.at(-1).channel, 'server-host:log');
  assert.equal((await f.manager.startServer(serverB)).success, false);
  assert.equal((await f.manager.startServer(serverA)).success, false);
  assert.equal(f.configCalls.length, 1);
  server.onStop = async () => {};
  await f.manager.stopServer();
  assert.equal(f.logListeners.size, 0);
  assert.equal(await f.manager.getStats(), null);
  assert.deepEqual({ ...f.manager.getStatus() }, stopped);
  assert.equal(server.stops, 2);
});

test('failed startup plus cleanup preserves a stoppable owner and localized explicit failure', async () => {
  const server = runtime();
  const f = fixture(async () => server);
  f.i18n.setMainLanguage('en');
  server.onStart = async () => { throw new Error('Synthetic bind failure'); };
  server.onStop = async () => { throw new Error('Synthetic cleanup failure'); };
  const result = await f.manager.startServer(serverA);
  assert.equal(result.success, false);
  assert.match(result.error, /Try stopping it explicitly/);
  assert.match(result.error, /Synthetic bind failure/);
  assert.match(result.error, /Synthetic cleanup failure/);
  assert.equal(f.manager.getStatus().serverId, 'a');
  assert.equal(f.manager.getStatus().isRunning, true);
  assert.equal(f.logListeners.size, 1);
  assert.equal((await f.manager.startServer(serverB)).success, false);
  server.onStop = async () => {};
  await f.manager.stopServer();
  assert.equal(f.logListeners.size, 0);
  server.onStart = async () => {};
  assert.equal((await f.manager.startServer(serverB)).success, true);
});

test('data deletion waits for pending lifecycle mutations and never removes an owned database', async () => {
  const startGate = deferred();
  const stopGate = deferred();
  const server = runtime();
  server.onStart = () => startGate.promise;
  server.onStop = () => stopGate.promise;
  const f = fixture(async () => server);
  const start = f.manager.startServer(serverA);
  const deleteDuringStart = f.manager.deleteServerData('a');
  await flush();
  assert.equal(f.io.removed.length, 0);
  startGate.resolve();
  await start;
  assert.equal((await deleteDuringStart).success, false);
  assert.equal(f.io.removed.length, 0);
  const stop = f.manager.stopServer();
  const deleteAfterStop = f.manager.deleteServerData('a');
  await flush();
  assert.equal(f.io.removed.length, 0);
  stopGate.resolve();
  await stop;
  assert.equal((await deleteAfterStop).success, true);
  assert.deepEqual(f.io.removed, [path.join('C:\\', 'synthetic-monky-profile', 'server-data', 'a')]);
});

test('invalid IPC start inputs are rejected before any filesystem access or server creation', async () => {
  const f = fixture(async () => assert.fail('Invalid input must not create a server'));
  const invalid = [
    null, undefined, [], {},
    { ...serverA, port: 0 }, { ...serverA, port: 65536 }, { ...serverA, port: '3000' },
    { ...serverA, port: NaN }, { ...serverA, port: 3000.5 },
    { ...serverA, serverId: '..\\other' }, { ...serverA, serverId: '' }, { ...serverA, serverId: 1 },
    { ...serverA, serverName: null }, { ...serverA, password: false },
    { ...serverA, maxUsers: -1 }, { ...serverA, maxUsers: Infinity }, { ...serverA, voiceMode: 'invalid' },
  ];
  for (const options of invalid) {
    const result = await f.manager.startServer(options);
    assert.equal(result.success, false);
    assert.equal(result.error, f.i18n.mt('error.startServerFailed'));
  }
  assert.equal(f.io.directories.length, 0);
  assert.equal(f.configCalls.length, 0);
});
