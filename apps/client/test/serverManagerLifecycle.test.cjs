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
const stopped = { servers: [] };
const running = (...servers) => ({ servers });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function runtime(name = 'Synthetic server') {
  return {
    starts: 0, stops: 0, cleared: 0,
    logListeners: new Set(),
    onStart: async () => {},
    onStop: async () => {},
    async start() { this.starts++; await this.onStart(); },
    async stop() { this.stops++; await this.onStop(); },
    async getStats() { return { serverName: name }; },
    getUpdateInventory() { return { serverName: 'Live server', bots: [{ id: 'live', name: 'Live bot', protocolVersion: 40 }] }; },
    subscribeLogs(listener) { this.logListeners.add(listener); return () => this.logListeners.delete(listener); },
    getRecentLogs() { return [{ message: `recent from ${name}` }]; },
    clearLogs() { this.cleared++; },
    log(message) { for (const listener of this.logListeners) listener({ message }); },
  };
}

function fixture(create) {
  const configCalls = [];
  const events = [];
  const errors = [];
  const logListeners = new Set();
  const io = { directories: [], removed: [], renamed: [], existing: new Set(), failure: null, entries: [], snapshots: [],
    removal: null, removalFailure: null, serverLoads: 0, serverLoadFailure: null };
  const fakeFs = {
    existsSync: name => io.existing.has(name),
    mkdirSync(name) {
      io.directories.push(name);
      if (io.failure) throw io.failure;
    },
    renameSync: (from, to) => { io.renamed.push([from, to]); },
    rmSync: () => assert.fail('Deleting server data must not block the main process'),
    promises: {
      async rm(name, options) {
        assert.equal(options.recursive, true);
        assert.equal(options.force, true);
        io.removed.push(name);
        if (io.removal) await io.removal.promise;
        if (io.removalFailure) throw io.removalFailure;
      },
    },
    readdirSync: () => io.entries.map(name => ({ name, isDirectory: () => true, isSymbolicLink: () => false })),
  };
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      mainFrame: { isDestroyed: () => false, detached: false },
      send: (channel, ...args) => events.push({ channel, args: structuredClone(args) }),
    },
  };
  const dependencies = new Map([
    ['path', path], ['fs', fakeFs],
    ['electron', {
      app: { getPath: () => path.join('C:\\', 'synthetic-monky-profile'), getVersion: () => '44.7.9-beta' },
      BrowserWindow: {
        getAllWindows: () => [
          fakeWindow,
          { isDestroyed: () => true, webContents: { send: () => assert.fail('Destroyed window must be skipped') } },
          { isDestroyed: () => false, webContents: { isDestroyed: () => true, send: () => assert.fail('Destroyed renderer must be skipped') } },
          { isDestroyed: () => false, webContents: {
            isDestroyed: () => false, isCrashed: () => true,
            send: () => assert.fail('A crashed renderer may retain its WebContents but cannot receive IPC'),
          } },
          { isDestroyed: () => false, webContents: {
            isDestroyed: () => false, isCrashed: () => false,
            mainFrame: { isDestroyed: () => true },
            send: () => assert.fail('A destroyed render frame cannot receive IPC'),
          } },
          { isDestroyed: () => false, webContents: {
            isDestroyed: () => false, isCrashed: () => false,
            mainFrame: { isDestroyed: () => false, detached: true },
            send: () => assert.fail('A detached render frame cannot receive IPC'),
          } },
        ],
      },
    }],
    ['@monky/shared', { LIMITS }],
    ['@monky/server', {
      readStoredUpdateInventory: async filename => {
        io.snapshots.push(filename);
        return { serverName: 'Stored server', bots: [{ id: 'old', name: 'Offline bot', protocolVersion: 23 }] };
      },
      MonkyServer: { create: async config => { configCalls.push({ ...config }); return create(config); } },
      Logger: {
        subscribe: callback => { logListeners.add(callback); return () => logListeners.delete(callback); },
        getRecent: () => assert.fail('The global log buffer mixes servers and must not be read'),
        clearBuffer: () => assert.fail('The global log buffer mixes servers and must not be cleared'),
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
        if (request === '@monky/server') {
          io.serverLoads++;
          if (io.serverLoadFailure) throw io.serverLoadFailure;
        }
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

test('real ServerManager wiring serializes concurrent IPC starts and never replaces a hosted identity or port', async () => {
  const gate = deferred();
  const server = runtime();
  server.onStart = () => gate.promise;
  const f = fixture(async () => server);
  const first = f.manager.startServer({ ...serverA, voiceMode: 'sfu', maxUsers: 8 });
  const duplicate = f.manager.startServer({ ...serverA });
  const competing = f.manager.startServer({ ...serverB, port: serverA.port });
  const sameDataOtherPort = f.manager.startServer({ ...serverA, port: 3002 });
  await flush();
  assert.equal(f.configCalls.length, 1);
  assert.equal(f.configCalls[0].voiceMode, 'sfu');
  assert.equal(f.configCalls[0].maxUsers, 8);
  assert.equal(f.configCalls[0].version, '44.7.9-beta');
  assert.equal(f.configCalls[0].dataDir, path.join('C:\\', 'synthetic-monky-profile', 'server-data', 'a'));
  assert.equal(server.starts, 1);
  assert.deepEqual(structuredClone(f.manager.getStatus()), stopped);
  gate.resolve();
  const results = await Promise.all([first, duplicate, competing, sameDataOtherPort]);
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, true);
  assert.equal(results[2].error, f.i18n.mt('error.hostedServerAlreadyRunning', { port: '3000' }));
  assert.equal(results[3].error, f.i18n.mt('error.hostedServerIdentityRunning', { port: '3000' }),
    'one data folder can never be opened by two instances');
  assert.equal(f.io.directories.length, 1);
  assert.equal(f.configCalls.length, 1);
  assert.equal(server.stops, 0);
  assert.equal(server.logListeners.size, 1);
  assert.equal(f.logListeners.size, 0, 'logs come from the instance, never the process-wide logger');
  assert.deepEqual(structuredClone(f.manager.getStatus()), running({ port: 3000, serverId: 'a' }));
  assert.deepEqual(f.events, [{
    channel: 'server-host:status-changed',
    args: [running({ port: 3000, serverId: 'a' })],
  }]);
});

test('two servers run side by side, each with its own stats, logs and stop', async () => {
  const first = runtime('A');
  const second = runtime('B');
  const f = fixture(async config => config.port === 3000 ? first : second);
  assert.equal((await f.manager.startServer(serverA)).success, true);
  assert.equal((await f.manager.startServer(serverB)).success, true);
  assert.deepEqual(structuredClone(f.manager.getStatus()), running({ port: 3000, serverId: 'a' }, { port: 3001, serverId: 'b' }));
  assert.deepEqual(f.configCalls.map(config => config.dataDir), [
    path.join('C:\\', 'synthetic-monky-profile', 'server-data', 'a'),
    path.join('C:\\', 'synthetic-monky-profile', 'server-data', 'b'),
  ]);
  assert.equal((await f.manager.getStats(3000)).serverName, 'A');
  assert.equal((await f.manager.getStats(3001)).serverName, 'B');
  assert.equal(await f.manager.getStats(3002), null);
  assert.deepEqual(f.manager.getLogs(3001), [{ message: 'recent from B' }]);
  assert.deepEqual([...f.manager.getLogs(3002)], []);
  f.manager.clearLogs(3000);
  assert.equal(first.cleared, 1);
  assert.equal(second.cleared, 0);

  second.log('only B');
  first.log('only A');
  const logs = f.events.filter(event => event.channel === 'server-host:log').map(event => event.args);
  assert.deepEqual(logs, [[3001, { message: 'only B' }], [3000, { message: 'only A' }]], 'every log is tagged with its port');

  await f.manager.stopServer(3000);
  assert.equal(first.stops, 1);
  assert.equal(second.stops, 0, 'stopping one server leaves the other running');
  assert.equal(first.logListeners.size, 0);
  assert.equal(second.logListeners.size, 1);
  assert.deepEqual(structuredClone(f.manager.getStatus()), running({ port: 3001, serverId: 'b' }));
  await f.manager.stopServer(3000);
  assert.equal(first.stops, 1, 'stopping a port that is not hosted is a no-op');

  assert.equal((await f.manager.startServer(serverA)).success, true);
  await f.manager.stopAll();
  assert.equal(first.stops, 2);
  assert.equal(second.stops, 1);
  assert.deepEqual(structuredClone(f.manager.getStatus()), stopped);
  assert.equal(first.logListeners.size + second.logListeners.size, 0);
});

test('stopAll tries every server even when one fails to stop', async () => {
  const first = runtime('A');
  const second = runtime('B');
  const f = fixture(async config => config.port === 3000 ? first : second);
  await f.manager.startServer(serverA);
  await f.manager.startServer(serverB);
  first.onStop = async () => { throw new Error('Synthetic shutdown failure'); };
  await assert.rejects(f.manager.stopAll(), /Synthetic shutdown failure/);
  assert.equal(second.stops, 1);
  assert.deepEqual(structuredClone(f.manager.getStatus()), running({ port: 3000, serverId: 'a' }));
  first.onStop = async () => {};
  await f.manager.stopAll();
  assert.deepEqual(structuredClone(f.manager.getStatus()), stopped);
});

test('update inventory includes stopped and legacy servers but reads live in-memory servers without stale disk data', async () => {
  const f = fixture(async () => runtime());
  const base = path.join('C:\\', 'synthetic-monky-profile', 'server-data');
  f.io.existing.add(base);
  f.io.entries.push('a', 'b', '..');
  for (const id of ['a', 'b']) f.io.existing.add(path.join(base, id, 'server.db'));
  await f.manager.startServer(serverA);
  let result = await f.manager.getUpdateInventory();
  assert.equal(result.length, 2);
  assert.equal(result[0].bots[0].id, 'live');
  assert.equal(result[1].bots[0].id, 'old');
  assert.deepEqual(f.io.snapshots, [path.join(base, 'b', 'server.db')]);
  await f.manager.startServer(serverB);
  result = await f.manager.getUpdateInventory();
  assert.deepEqual([...result.map(server => server.bots[0].id)], ['live', 'live'], 'every running server is read live');
  await f.manager.stopAll();
  f.io.existing.add(path.join(base, 'server.db'));
  result = await f.manager.getUpdateInventory();
  assert.equal(result.length, 3);
  assert.equal(result[0].serverId, null);
  assert.equal(f.io.removed.length, 0);
});

test('the hosted server code loads on first use, never just to open Monky, and a failed load is retried (E-MAIN-7)', async () => {
  const f = fixture(async () => runtime());
  assert.deepEqual(structuredClone(f.manager.getStatus()), stopped);
  assert.deepEqual([...await f.manager.getUpdateInventory()], []);
  await f.manager.stopAll();
  assert.equal(f.io.serverLoads, 0, 'opening Monky, an empty inventory and stopping nothing never load the server code');
  f.io.serverLoadFailure = new Error('Synthetic damaged installation');
  assert.deepEqual(structuredClone(await f.manager.startServer(serverA)), { success: false, error: 'Synthetic damaged installation' });
  assert.deepEqual(structuredClone(f.manager.getStatus()), stopped);
  f.io.serverLoadFailure = null;
  assert.equal((await f.manager.startServer(serverA)).success, true, 'the next start loads the server code again');
  assert.equal((await f.manager.startServer(serverB)).success, true);
  assert.equal(f.io.serverLoads, 2, 'once the code loaded, later servers reuse it');
  await f.manager.stopAll();
});

test('legacy data cannot be relabeled by a same-port caller and conflict errors follow native language', async () => {
  const server = runtime();
  const f = fixture(async () => server);
  await f.manager.startServer({ port: 3000, serverName: 'Legacy' });
  f.i18n.setMainLanguage('en');
  const conflict = await f.manager.startServer(serverA);
  assert.equal(conflict.success, false);
  assert.match(conflict.error, /^Another of your servers is already using port 3000/);
  assert.deepEqual(structuredClone(f.manager.getStatus()), running({ port: 3000, serverId: null }));
  assert.equal(server.stops, 0);
  assert.equal(f.configCalls.length, 1);
  assert.equal((await f.manager.startServer({ port: 3000, serverName: 'Legacy duplicate' })).success, true);
  assert.equal((await f.manager.startServer({ port: 3005, serverName: 'Legacy elsewhere' })).success, false,
    'the legacy folder cannot be opened twice either');
  await f.manager.stopServer(3000);
  await f.manager.startServer(serverA);
  assert.equal((await f.manager.startServer({ port: 3000, serverName: 'Unknown' })).success, false);
  assert.equal(f.manager.getStatus().servers[0].serverId, 'a');
});

test('stop queued during creation and duplicate stops finish before the port is reused', async () => {
  const creation = deferred();
  const stopping = deferred();
  const firstServer = runtime();
  const secondServer = runtime();
  firstServer.onStop = () => stopping.promise;
  let created = 0;
  const f = fixture(async () => {
    if (++created > 1) return secondServer;
    await creation.promise;
    return firstServer;
  });
  const first = f.manager.startServer(serverA);
  const stop = f.manager.stopServer(3000);
  const duplicateStop = f.manager.stopServer(3000);
  const next = f.manager.startServer({ ...serverB, port: 3000 });
  await flush();
  assert.equal(f.configCalls.length, 1);
  assert.equal(firstServer.stops, 0);
  creation.resolve();
  assert.equal((await first).success, true);
  await flush();
  assert.equal(firstServer.stops, 1);
  assert.equal(firstServer.logListeners.size, 1);
  assert.equal(f.configCalls.length, 1);
  assert.equal(f.manager.getStatus().servers.length, 1);
  stopping.resolve();
  await Promise.all([stop, duplicateStop]);
  assert.equal((await next).success, true);
  assert.equal(firstServer.stops, 1);
  assert.equal(firstServer.logListeners.size, 0);
  assert.equal(secondServer.starts, 1);
  assert.equal(secondServer.logListeners.size, 1);
  assert.deepEqual(f.events.filter(event => event.channel === 'server-host:status-changed').map(event => event.args[0]), [
    running({ port: 3000, serverId: 'a' }), stopped, running({ port: 3000, serverId: 'b' }),
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
  assert.deepEqual(structuredClone(f.manager.getStatus()), stopped);
  f.io.failure = null;
  assert.equal((await f.manager.startServer(serverA)).error, 'Synthetic bind failure');
  assert.equal(broken.stops, 1);
  assert.equal(broken.logListeners.size, 0);
  assert.deepEqual(structuredClone(f.manager.getStatus()), stopped);
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
  await assert.rejects(f.manager.stopServer(3000), /Synthetic shutdown failure/);
  assert.deepEqual(structuredClone(f.manager.getStatus()), running({ port: 3000, serverId: 'a' }));
  assert.equal((await f.manager.getStats(3000)).serverName, 'Synthetic server');
  assert.equal(server.logListeners.size, 1);
  server.log('Still owned after failed stop');
  assert.deepEqual(f.events.at(-1), { channel: 'server-host:log', args: [3000, { message: 'Still owned after failed stop' }] });
  assert.equal((await f.manager.startServer({ ...serverB, port: 3000 })).success, false);
  assert.equal((await f.manager.startServer(serverA)).success, false);
  assert.equal(f.configCalls.length, 1);
  server.onStop = async () => {};
  await f.manager.stopServer(3000);
  assert.equal(server.logListeners.size, 0);
  assert.equal(await f.manager.getStats(3000), null);
  assert.deepEqual(structuredClone(f.manager.getStatus()), stopped);
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
  assert.deepEqual(structuredClone(f.manager.getStatus()), running({ port: 3000, serverId: 'a' }));
  assert.equal(server.logListeners.size, 1);
  assert.equal((await f.manager.startServer({ ...serverB, port: 3000 })).success, false);
  server.onStop = async () => {};
  await f.manager.stopServer(3000);
  assert.equal(server.logListeners.size, 0);
  server.onStart = async () => {};
  assert.equal((await f.manager.startServer({ ...serverB, port: 3000 })).success, true);
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
  const stop = f.manager.stopServer(3000);
  const deleteAfterStop = f.manager.deleteServerData('a');
  await flush();
  assert.equal(f.io.removed.length, 0);
  stopGate.resolve();
  await stop;
  assert.equal((await deleteAfterStop).success, true);
  assert.deepEqual(f.io.removed, [path.join('C:\\', 'synthetic-monky-profile', 'server-data', 'a')]);
});

test('data deletion runs off the main thread and holds the lifecycle queue until the folder is gone', async () => {
  const server = runtime();
  const f = fixture(async () => server);
  const removal = deferred();
  f.io.removal = removal;
  const deletion = f.manager.deleteServerData('a');
  await flush();
  assert.deepEqual(f.io.removed, [path.join('C:\\', 'synthetic-monky-profile', 'server-data', 'a')]);
  const start = f.manager.startServer(serverA);
  await flush();
  assert.equal(f.configCalls.length, 0, 'the same data folder cannot be reopened while it is being deleted');
  assert.deepEqual(structuredClone(f.manager.getStatus()), stopped);
  removal.resolve();
  assert.equal((await deletion).success, true);
  assert.equal((await start).success, true);
  assert.equal(server.starts, 1);
  await f.manager.stopServer(serverA.port);
  f.io.removal = null;
  f.io.removalFailure = new Error('Synthetic sharing violation');
  const failed = await f.manager.deleteServerData('a');
  assert.equal(failed.success, false);
  assert.equal(failed.error, 'Synthetic sharing violation');
  f.io.removalFailure = null;
  assert.equal((await f.manager.startServer(serverA)).success, true, 'a failed deletion does not wedge the queue');
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