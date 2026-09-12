import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as mediasoup from 'mediasoup';
import { WebSocket } from 'ws';
import { LIMITS, MessageType } from '@monky/shared';
import { MonkyServer, type ServerConfig } from './server';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqlJsDriver, type DatabaseCloseOptions } from './infrastructure/database/SqliteWrapper';
import { SqliteChannelRepository, SqliteRoleRepository, SqliteServerRepository } from './infrastructure/database/SqliteRepositories';
import { ServerResourceScope } from './infrastructure/lifecycle/ServerResourceScope';
import { closeHttpServer, listenHttpServer } from './infrastructure/lifecycle/httpLifecycle';
import { Logger } from './infrastructure/logger/Logger';
import { SfuManager } from './infrastructure/sfu/SfuManager';
import type { WebSocketServer } from './infrastructure/websocket/WebSocketServer';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function temporaryData(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-startup-lifecycle-'));
  const cleanup: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const action of cleanup.reverse()) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    fs.rmSync(directory, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed');
  });
  t.mock.method(Logger, 'info', () => {});
  return { directory, cleanup, filename: path.join(directory, 'server.db') };
}

async function fixture(t: TestContext, options: Partial<ServerConfig> = {}) {
  const data = temporaryData(t);
  const server = await MonkyServer.create({
    port: 0, dataDir: data.directory, serverName: 'Lifecycle fixture', ...options,
  });
  data.cleanup.push(() => server.stop());
  t.mock.method(server['lanBroadcaster'], 'start', async () => {});
  t.mock.method(server['attachmentService'], 'reconcile', async () => {});
  const listener = server['httpServer'];
  const nativeListen = listener.listen.bind(listener);
  // Even positive startup scenarios can bind only a fresh loopback port.
  t.mock.method(listener, 'listen', (_port: number, _host: string) => nativeListen(0, '127.0.0.1'));
  return { ...data, server, listener, nativeListen };
}

function assertReleased(server: MonkyServer): void {
  assert.equal(server['httpServer'].listening, false);
  assert.equal(server['rateLimiter']['cleanupTimer'], null);
  assert.equal(server['wsServer']['heartbeatTimer'], undefined);
  assert.equal(server['wsServer']['reconnectTimers'].size, 0);
  const driver = server['dbConn'].getDb();
  assert.ok(driver instanceof SqlJsDriver);
  assert.equal(driver['isClosed'], true);
  assert.equal(driver['saveTimer'], null);
}

function syntheticWorker() {
  const worker = Object.create(EventEmitter.prototype) as mediasoup.types.Worker;
  let closes = 0;
  Object.defineProperty(worker, 'died', { value: false });
  worker.close = () => { closes++; };
  return { worker, closes: () => closes };
}

function failSnapshotWrites(t: TestContext, filename: string, failure: Error) {
  const descriptors = new Set<number>();
  const rawOpen = fs.openSync;
  const rawWrite = fs.writeFileSync;
  const rawClose = fs.closeSync;
  const open = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const descriptor = rawOpen(...args);
    if (typeof args[0] === 'string' && args[0].startsWith(`${filename}.tmp-`)) descriptors.add(descriptor);
    return descriptor;
  });
  const write = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (typeof args[0] === 'number' && descriptors.has(args[0])) {
      rawWrite(args[0], Buffer.from('incomplete database bytes'));
      throw failure;
    }
    return rawWrite(...args);
  });
  const close = t.mock.method(fs, 'closeSync', (descriptor: number) => {
    descriptors.delete(descriptor);
    return rawClose(descriptor);
  });
  return { restore() { close.mock.restore(); write.mock.restore(); open.mock.restore(); } };
}

test('HTTP bind helpers reject synchronous errors and remove temporary listeners before retry', async (t) => {
  const listener = http.createServer();
  const originalErrors = listener.listenerCount('error');
  const originalListening = listener.listenerCount('listening');
  const failure = new Error('Synthetic synchronous listen failure');
  const mock = t.mock.method(listener, 'listen', () => { throw failure; });
  await assert.rejects(listenHttpServer(listener, 0, '127.0.0.1'), error => error === failure);
  assert.equal(listener.listenerCount('error'), originalErrors);
  assert.equal(listener.listenerCount('listening'), originalListening);
  mock.mock.restore();
  try {
    await listenHttpServer(listener, 0, '127.0.0.1');
    assert.equal(listener.listenerCount('error'), originalErrors);
    assert.equal(listener.listenerCount('listening'), originalListening);
  } finally {
    await closeHttpServer(listener);
  }
});

test('HTTP cleanup handles never-listening candidates but does not disguise other close failures', async (t) => {
  const listener = http.createServer();
  await closeHttpServer(listener);
  const failure = new Error('Synthetic close failure');
  const mock = t.mock.method(listener, 'close', (callback?: (error?: Error) => void) => {
    callback?.(failure);
    return listener;
  });
  await assert.rejects(closeHttpServer(listener), error => error === failure);
  mock.mock.restore();
  await closeHttpServer(listener);
});

test('a stalled HTTP shutdown rejects explicitly rather than permanently poisoning lifecycle retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listener = http.createServer();
  const close = t.mock.method(listener, 'close', () => listener);
  const forced = t.mock.method(listener, 'closeAllConnections', () => {});
  const pending = assert.rejects(closeHttpServer(listener), /shutdown deadline/);
  t.mock.timers.tick(LIMITS.SHUTDOWN_GRACE_MS * 3);
  await pending;
  assert.equal(forced.mock.callCount(), 1);
  close.mock.restore();
  await closeHttpServer(listener);
});

test('actual loopback EADDRINUSE rejects through WSS forwarding and the same instance can retry', async (t) => {
  const f = await fixture(t);
  const errors = t.mock.method(Logger, 'error', () => {});
  const blocker = http.createServer();
  await listenHttpServer(blocker, 0, '127.0.0.1');
  f.cleanup.push(() => closeHttpServer(blocker));
  const address = blocker.address();
  assert.ok(address && typeof address !== 'string');
  const originalErrorListeners = f.listener.listenerCount('error');
  const originalListeningListeners = f.listener.listenerCount('listening');
  const bind = t.mock.method(f.listener, 'listen', (_port: number, _host: string) => f.nativeListen(address.port, '127.0.0.1'));
  const first = f.server.start();
  assert.equal(f.server.start(), first, 'Duplicate pending starts must share the actual readiness promise');
  await assert.rejects(first, error => error instanceof Error && 'code' in error && error.code === 'EADDRINUSE');
  assert.equal(f.server['startedAt'], null);
  assert.equal(f.listener.listening, false);
  assert.equal(f.listener.listenerCount('error'), originalErrorListeners);
  assert.equal(f.listener.listenerCount('listening'), originalListeningListeners);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(errors.mock.calls[0].arguments[1], 'WebSocket server error');
  bind.mock.restore();
  await closeHttpServer(blocker);
  await f.server.start();
  const running = f.listener.address();
  assert.ok(running && typeof running !== 'string');
  assert.equal(running.address, '127.0.0.1');
  const ready = f.server.start();
  assert.equal(f.server.start(), ready);
  await ready;
  await f.server.stop();
  assertReleased(f.server);
});

test('the native factory-start-cleanup-retry contract releases a rejected candidate before creating its replacement', async (t) => {
  const f = await fixture(t);
  const failure = Object.assign(new Error('Synthetic asynchronous bind failure'), { code: 'EADDRINUSE' });
  t.mock.method(Logger, 'error', () => {});
  t.mock.method(f.listener, 'listen', () => {
    queueMicrotask(() => f.listener.emit('error', failure));
    return f.listener;
  });
  await assert.rejects(f.server.start(), error => error === failure);
  await f.server.stop();
  assertReleased(f.server);
  const retry = await MonkyServer.create({ port: 0, dataDir: f.directory });
  f.cleanup.push(() => retry.stop());
  const listener = retry['httpServer'];
  const nativeListen = listener.listen.bind(listener);
  t.mock.method(listener, 'listen', (_port: number, _host: string) => nativeListen(0, '127.0.0.1'));
  t.mock.method(retry['lanBroadcaster'], 'start', async () => {});
  await retry.start();
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  await retry.stop();
  assertReleased(retry);
});

test('server-level listener errors never disconnect or evict existing voice sessions', async (t) => {
  const f = await fixture(t);
  const errors = t.mock.method(Logger, 'error', () => {});
  await f.server.start();
  const server = f.server['wsServer'];
  const record = await f.server['serverRepo'].getServer();
  assert.ok(record);
  const channels = await new SqliteChannelRepository(f.server['dbConn'].getDb()).listByServerId(record.id);
  const channel = channels.find(entry => entry.type === 'VOICE');
  assert.ok(channel);
  const socket = Object.create(WebSocket.prototype) as WebSocket;
  Object.defineProperty(socket, 'readyState', { configurable: true, value: WebSocket.OPEN });
  socket.send = () => {};
  let closes = 0;
  const session: Parameters<WebSocketServer['handleServerUpdateSettings']>[0] = {
    ws: socket, sessionId: 'retained-session', isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
    user: { id: 'retained-user', clientId: 'test-key', sessionId: 'retained-session', nickname: 'Peer', status: 'ONLINE', joinedAt: 1 },
  };
  socket.close = () => {
    closes++;
    Object.defineProperty(socket, 'readyState', { value: WebSocket.CLOSED });
    server['handleDisconnect'](session);
  };
  server['sessions'].set(socket, session);
  server['sessionSockets'].set('retained-session', socket);
  const joined = await server['signalingService'].joinVoiceChannel('retained-session', 'retained-user', channel.id);
  assert.equal(joined.success, true);
  const state = server['signalingService'].getVoiceState('retained-session');
  const closeSfu = t.mock.method(f.server['sfuManager'], 'close');
  assert.doesNotThrow(() => f.listener.emit('error', new Error('Synthetic runtime listener error')));
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(closes, 0);
  assert.equal(closeSfu.mock.callCount(), 0);
  assert.equal(server['sessions'].get(socket), session);
  assert.equal(server['signalingService'].getVoiceState('retained-session'), state);
  assert.equal(f.listener.listening, true);
  await f.server.start();
  assert.equal(closes, 0);
  await f.server.stop();
  assert.equal(closes, 1);
  assert.deepEqual(server['signalingService'].getAllVoiceStates(), {});
  assertReleased(f.server);
});

test('acknowledged shutdown delivers the existing notice and drains actual loopback WebSocket peers', async (t) => {
  const f = await fixture(t);
  await f.server.start();
  const address = f.listener.address();
  assert.ok(address && typeof address !== 'string');
  const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
  f.cleanup.push(() => peer.terminate());
  await once(peer, 'open');
  const server = f.server['wsServer'];
  const session = [...server['sessions'].values()][0];
  assert.ok(session);
  session.sessionId = 'loopback-session';
  session.user = { id: 'loopback-user', clientId: 'fixture-key', sessionId: session.sessionId, nickname: 'Loopback', status: 'ONLINE', joinedAt: 1 };
  const notices: string[] = [];
  peer.on('message', data => {
    const message: unknown = JSON.parse(data.toString());
    if (message && typeof message === 'object' && 'type' in message && typeof message.type === 'string') notices.push(message.type);
  });
  const closed = once(peer, 'close');
  await f.server.stop();
  await closed;
  assert.ok(notices.includes(MessageType.SERVER_SHUTDOWN));
  assert.equal(server['sessions'].size, 0);
  assert.equal(server['wss'].clients.size, 0);
  assertReleased(f.server);
});

test('shutdown during pending bind waits for settlement and prevents late startup work', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.listener, 'listen', () => f.listener);
  const start = f.server.start();
  const rejected = assert.rejects(start, /interrupted by shutdown/);
  let stopped = false;
  const stop = f.server.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  f.listener.emit('listening');
  await rejected;
  await stop;
  assert.equal(f.server['startupTasks'].length, 0);
  assertReleased(f.server);
  await assert.rejects(f.server.start(), /shutdown has already started/);
});

test('shutdown waits for pending LAN startup instead of leaving a late broadcaster alive', async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  let startedLan = false;
  let stoppedLan = false;
  t.mock.method(f.server['lanBroadcaster'], 'start', async () => { await gate.promise; startedLan = true; });
  t.mock.method(f.server['lanBroadcaster'], 'stop', async () => { stoppedLan = true; startedLan = false; });
  const start = f.server.start();
  await flush();
  assert.equal(f.listener.listening, true);
  const rejected = assert.rejects(start, /interrupted by shutdown/);
  const stop = f.server.stop();
  try {
    await flush();
    assert.equal(stoppedLan, false);
  } finally {
    gate.resolve();
  }
  await rejected;
  await stop;
  assert.equal(stoppedLan, true);
  assert.equal(startedLan, false);
  assertReleased(f.server);
});

test('shutdown drains deferred TURN and reconciliation before disposing their process or database', async (t) => {
  const f = await fixture(t);
  await f.server['serverRepo'].updateServer({ turnEnabled: true, turnSecret: 'synthetic-test-secret' });
  const turn = deferred();
  const reconcile = deferred();
  let running = false;
  let stopCalls = 0;
  let reconciledWithOpenDatabase = false;
  t.mock.method(f.server['coturnManager'], 'start', async () => { await turn.promise; running = true; return true; });
  t.mock.method(f.server['coturnManager'], 'stop', async () => { stopCalls++; running = false; });
  t.mock.method(f.server['attachmentService'], 'reconcile', async () => {
    await reconcile.promise;
    const driver = f.server['dbConn'].getDb();
    assert.ok(driver instanceof SqlJsDriver);
    reconciledWithOpenDatabase = !driver['isClosed'];
    await f.server['serverRepo'].getServer();
  });
  await f.server.start();
  let stopped = false;
  const stop = f.server.stop().then(() => { stopped = true; });
  try {
    await flush();
    assert.equal(stopped, false);
    assert.equal(stopCalls, 0);
    turn.resolve();
    await flush();
    assert.equal(stopped, false);
    assert.equal(running, true);
  } finally {
    turn.resolve();
    reconcile.resolve();
  }
  await stop;
  assert.equal(reconciledWithOpenDatabase, true);
  assert.equal(stopCalls, 1);
  assert.equal(running, false);
  assertReleased(f.server);
});

test('resource cleanup attempts every release, preserves setup errors and retries only unfinished work', async () => {
  const resources = new ServerResourceScope();
  const order: string[] = [];
  const setupError = new Error('Synthetic setup failure');
  let broken = true;
  resources.defer('first', () => { order.push('first'); });
  resources.defer('second', () => { order.push('second'); if (broken) throw new Error('Synthetic release failure'); });
  resources.defer('third', async () => { order.push('third'); });
  await assert.rejects(resources.fail(setupError), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, setupError);
    assert.match(error.message, /Synthetic setup failure/);
    assert.match(error.message, /Synthetic release failure/);
    return true;
  });
  assert.deepEqual(order, ['third', 'second', 'first']);
  broken = false;
  const retry = resources.close();
  assert.equal(resources.close(), retry);
  await retry;
  await resources.close();
  assert.deepEqual(order, ['third', 'second', 'first', 'second']);
});

test('an initial database write failure releases its unpublished WASM allocation and permits retry', async (t) => {
  const f = temporaryData(t);
  const failure = new Error('Synthetic initial database write failure');
  const write = failSnapshotWrites(t, f.filename, failure);
  t.mock.method(console, 'error', () => {});
  let released: SqlJsDriver | undefined;
  const close = SqlJsDriver.prototype.close;
  t.mock.method(SqlJsDriver.prototype, 'close', function (this: SqlJsDriver, options?: DatabaseCloseOptions) {
    released = this;
    return close.call(this, options);
  });
  try {
    await assert.rejects(SqlJsDriver.create(f.filename), error => error === failure);
    assert.ok(released);
    assert.equal(released['isClosed'], true);
    assert.equal(released['saveTimer'], null);
    assert.equal(fs.existsSync(f.filename), false, 'Partial initial bytes must not poison the next factory attempt');
    assert.deepEqual(fs.readdirSync(f.directory), [], 'An owned partial snapshot must be removed');
  } finally {
    write.restore();
  }
  const retry = await SqlJsDriver.create(f.filename);
  f.cleanup.push(() => retry.close());
  assert.equal(retry['isClosed'], false);
});

test('migration failure closes the driver instead of leaking a hidden database or save timer', async (t) => {
  const f = temporaryData(t);
  const failure = new Error('Synthetic migration failure');
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseConnection.prototype, 'runMigrations');
  assert.ok(descriptor);
  let released: SqlJsDriver | undefined;
  const close = SqlJsDriver.prototype.close;
  t.mock.method(SqlJsDriver.prototype, 'close', function (this: SqlJsDriver, options?: DatabaseCloseOptions) {
    released = this;
    return close.call(this, options);
  });
  Object.defineProperty(DatabaseConnection.prototype, 'runMigrations', { ...descriptor, value() { throw failure; } });
  try {
    await assert.rejects(DatabaseConnection.create(f.filename), error => error === failure);
    assert.ok(released);
    assert.equal(released['isClosed'], true);
    assert.equal(released['saveTimer'], null);
  } finally {
    Object.defineProperty(DatabaseConnection.prototype, 'runMigrations', descriptor);
  }
  const retry = await DatabaseConnection.create(f.filename);
  f.cleanup.push(() => retry.close());
  assert.equal(await new SqliteServerRepository(retry.getDb()).getServer(), null);
});

test('partially failed seeding rolls back before cleanup so a retry gets its complete original channels and roles', async (t) => {
  const f = temporaryData(t);
  const failure = new Error('Synthetic role seed failure');
  const create = SqliteRoleRepository.prototype.create;
  const seed = t.mock.method(SqliteRoleRepository.prototype, 'create', async function (
    this: SqliteRoleRepository, ...args: Parameters<SqliteRoleRepository['create']>
  ) {
    await create.apply(this, args);
    throw failure;
  });
  let released: SqlJsDriver | undefined;
  const close = SqlJsDriver.prototype.close;
  t.mock.method(SqlJsDriver.prototype, 'close', function (this: SqlJsDriver, options?: DatabaseCloseOptions) {
    released = this;
    return close.call(this, options);
  });
  try {
    await assert.rejects(MonkyServer.create({ port: 0, dataDir: f.directory, serverName: 'Failed seed' }), error => error === failure);
    assert.ok(released);
    assert.equal(released['isClosed'], true);
    assert.equal(released['saveTimer'], null);
  } finally {
    seed.mock.restore();
  }
  const retry = await MonkyServer.create({ port: 0, dataDir: f.directory, serverName: 'Complete retry' });
  f.cleanup.push(() => retry.stop());
  const record = await retry['serverRepo'].getServer();
  assert.ok(record);
  assert.equal(record.name, 'Complete retry');
  const db = retry['dbConn'].getDb();
  assert.deepEqual((await new SqliteChannelRepository(db).listByServerId(record.id)).map(channel => channel.type).sort(), ['TEXT', 'VOICE']);
  assert.ok(await new SqliteRoleRepository(db).findByName('Admin'));
  assert.ok(await new SqliteRoleRepository(db).findByName('Membro'));
  await retry.stop();
  assertReleased(retry);
});

test('a late setup commit failure waits for SFU warmup cleanup and releases every unpublished resource', async (t) => {
  const f = temporaryData(t);
  const gate = deferred();
  const entered = deferred();
  const failure = new Error('Synthetic setup commit failure');
  let activeWorker = false;
  let closedWorkers = 0;
  let captured: MonkyServer | undefined;
  const sfuClose = SfuManager.prototype.close;
  t.mock.method(SfuManager.prototype, 'init', async () => {
    entered.resolve();
    await gate.promise;
    activeWorker = true;
    return true;
  });
  t.mock.method(SfuManager.prototype, 'close', function (this: SfuManager) {
    closedWorkers++;
    activeWorker = false;
    sfuClose.call(this);
  });
  const transaction = SqlJsDriver.prototype.transactionAsync;
  t.mock.method(SqlJsDriver.prototype, 'transactionAsync', async function <T>(
    this: SqlJsDriver, operation: () => Promise<T>,
  ): Promise<T> {
    const database = this['db'];
    const exec = database.exec.bind(database);
    const commit = t.mock.method(database, 'exec', (...args: Parameters<typeof database.exec>) => {
      if (args[0] === 'COMMIT;') throw failure;
      return exec(...args);
    });
    try {
      return await transaction.bind(this)(async () => {
        const result = await operation();
        if (result instanceof MonkyServer) captured = result;
        return result;
      });
    } finally {
      commit.mock.restore();
    }
  });
  let settled = false;
  const pending = MonkyServer.create({ port: 0, dataDir: f.directory, voiceMode: 'sfu' });
  const rejected = assert.rejects(pending, error => error === failure).then(() => { settled = true; });
  try {
    await entered.promise;
    await flush();
    assert.ok(captured);
    assert.equal(settled, false);
    assert.equal(closedWorkers, 0);
    assert.equal(captured['wsServer']['heartbeatTimer'], undefined);
    assert.equal(captured['httpServer'].listening, false);
  } finally {
    gate.resolve();
  }
  await rejected;
  assert.ok(captured);
  assertReleased(captured);
  assert.equal(activeWorker, false);
  assert.ok(closedWorkers >= 1);
});

test('failed shutdown persistence keeps its database available for explicit retry instead of claiming closure', async (t) => {
  const f = await fixture(t);
  const failure = new Error('Synthetic final persistence failure');
  const previousBytes = fs.readFileSync(f.filename);
  const write = failSnapshotWrites(t, f.filename, failure);
  t.mock.method(console, 'error', () => {});
  const driver = f.server['dbConn'].getDb();
  assert.ok(driver instanceof SqlJsDriver);
  try {
    await assert.rejects(f.server.stop(), /Synthetic final persistence failure/);
    assert.equal(driver['isClosed'], false);
    assert.equal(f.server['stopped'], false);
    assert.equal(f.server['rateLimiter']['cleanupTimer'], null);
    assert.equal(f.server['wsServer']['heartbeatTimer'], undefined);
    assert.deepEqual(fs.readFileSync(f.filename), previousBytes, 'Failed snapshot replacement must retain the last valid database');
    assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('server.db.tmp-')), false);
  } finally {
    write.restore();
  }
  await f.server.stop();
  assertReleased(f.server);
});

test('concurrent SFU startup requests share one worker and late death events cannot poison a new generation', async (t) => {
  const first = syntheticWorker();
  const second = syntheticWorker();
  const gate = deferred<mediasoup.types.Worker>();
  let attempts = 0;
  t.mock.method(mediasoup, 'createWorker', () => ++attempts === 1 ? gate.promise : Promise.resolve(second.worker));
  const sfu = new SfuManager({ announcedIp: '127.0.0.1' });
  t.after(() => sfu.close());
  const pending = sfu.init();
  assert.equal(sfu.init(), pending);
  assert.equal(attempts, 1);
  gate.resolve(first.worker);
  assert.equal(await pending, true);
  sfu.close();
  assert.equal(first.closes(), 1);
  assert.equal(await sfu.init(), true);
  first.worker.emit('died', new Error('Stale worker death'));
  assert.equal(sfu.isReady(), true);
  assert.equal(sfu['worker'], second.worker);
  sfu.close();
  assert.equal(second.closes(), 1);
});

test('SFU workers created after cancellation close without replacing a newer active worker', async (t) => {
  const stale = syntheticWorker();
  const current = syntheticWorker();
  const gate = deferred<mediasoup.types.Worker>();
  let attempts = 0;
  t.mock.method(mediasoup, 'createWorker', () => ++attempts === 1 ? gate.promise : Promise.resolve(current.worker));
  const sfu = new SfuManager({ announcedIp: '127.0.0.1' });
  t.after(() => sfu.close());
  const old = sfu.init();
  sfu.close();
  assert.equal(await sfu.init(), true);
  gate.resolve(stale.worker);
  assert.equal(await old, false);
  assert.equal(stale.closes(), 1);
  assert.equal(current.closes(), 0);
  assert.equal(sfu['worker'], current.worker);
  assert.equal(sfu.isReady(), true);
});

test('a failed close of a late SFU worker remains owned for retry without damaging the new live generation', async (t) => {
  const stale = syntheticWorker();
  const current = syntheticWorker();
  const gate = deferred<mediasoup.types.Worker>();
  const failure = new Error('Synthetic stale worker cleanup failure');
  let attempts = 0;
  let broken = true;
  const close = stale.worker.close;
  stale.worker.close = () => { if (broken) throw failure; close(); };
  t.mock.method(mediasoup, 'createWorker', () => ++attempts === 1 ? gate.promise : Promise.resolve(current.worker));
  const sfu = new SfuManager({ announcedIp: '127.0.0.1' });
  t.after(() => { broken = false; sfu.close(); });
  const old = sfu.init();
  sfu.close();
  assert.equal(await sfu.init(), true);
  const rejected = assert.rejects(old, error => error === failure);
  gate.resolve(stale.worker);
  await rejected;
  assert.equal(sfu['retiringWorkers'].has(stale.worker), true);
  assert.equal(sfu.isReady(), true);
  assert.equal(sfu['worker'], current.worker);
  broken = false;
  sfu.close();
  assert.equal(stale.closes(), 1);
  assert.equal(current.closes(), 1);
  assert.equal(sfu['retiringWorkers'].size, 0);
});
