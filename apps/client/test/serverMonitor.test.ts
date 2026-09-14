import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MessageType, Permission, SERVER_MONITOR_LIMITS, hasPermission,
  type LogEntry, type ServerMonitorGetPayload, type ServerMonitorSnapshotPayload, type ServerStats,
} from '@monky/shared';
import {
  LocalServerMonitorSource, RemoteServerMonitorSource, ServerMonitorError, ServerMonitorFeed,
  type LocalMonitorApi, type MonitorUpdate, type ServerMonitorSource,
} from '../src/renderer/core/ServerMonitorFeed';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const stats = {
  serverName: 'Server A', port: 3000, startedAt: 1000, uptimeMs: 1000,
  onlineUsers: 2, members: 3, channels: 2, messages: 4, maxUsers: 10,
};
const log: LogEntry = {
  timestamp: '2026-09-14T13:00:00.000Z', level: 'INFO', category: 'NETWORK', message: 'A user joined the server.',
};
const snapshot = (cursor = 1): ServerMonitorSnapshotPayload => ({
  serverId: 'server-a', stats: { ...stats },
  entries: [{ ...log, sequence: cursor }], cursor, dropped: 0,
});
const update = (): MonitorUpdate => ({ stats: { ...stats }, entries: [{ ...log }], replaceLogs: true, dropped: 0 });

function remoteFixture() {
  let connectionId = 'socket-a';
  let status: ReturnType<ConstructorParameters<typeof RemoteServerMonitorSource>[0]['getStatus']> = 'CONNECTED';
  let allowed = Permission.VIEW_SERVER_MONITOR;
  let active = true;
  const store = {
    serverDetails: { id: 'server-a' },
    currentUser: { id: 'viewer', sessionId: 'viewer:device', isBot: false },
    hasPermission: (permission: Permission) => hasPermission(allowed, permission),
  };
  const requests: Array<{
    type: MessageType; payload: ServerMonitorGetPayload; id: string; timeout: number;
    result: ReturnType<typeof deferred<unknown>>;
  }> = [];
  const cancelled: string[] = [];
  const client: ConstructorParameters<typeof RemoteServerMonitorSource>[0] = {
    getStatus: () => status,
    getConnectionId: () => connectionId,
    sendRequest: (type, payload, id, timeout) => {
      const result = deferred<unknown>();
      requests.push({ type, payload, id, timeout, result });
      return result.promise;
    },
    cancelRequest: (id) => { cancelled.push(id); return true; },
  };
  const create = () => new RemoteServerMonitorSource(client, store, () => active);
  return {
    create, requests, cancelled, store,
    permission: (permissions: number) => { allowed = permissions; },
    disconnect: () => { status = 'RECONNECTING'; },
    replaceConnection: () => { connectionId = 'socket-b'; },
    switchServer: () => { active = false; },
  };
}

test('monitor polling is serialized and closing suppresses both late data and future timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred<MonitorUpdate>();
  const second = deferred<MonitorUpdate>();
  let reads = 0;
  let disposals = 0;
  const source: ServerMonitorSource = {
    assertCurrent: () => {},
    read: () => (++reads === 1 ? first.promise : second.promise),
    dispose: () => { disposals++; },
  };
  const updates: MonitorUpdate[] = [];
  const errors: unknown[] = [];
  const feed = new ServerMonitorFeed(source, (value) => updates.push(value), (error) => errors.push(error));
  const opening = feed.start();
  t.mock.timers.tick(30_000);
  assert.equal(reads, 1, 'no polling overlaps a pending request');
  first.resolve(update());
  await opening;
  t.mock.timers.tick(SERVER_MONITOR_LIMITS.POLL_INTERVAL_MS - 1);
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  assert.equal(reads, 2);
  feed.stop();
  second.resolve(update());
  await flush();
  t.mock.timers.tick(30_000);
  assert.equal(reads, 2);
  assert.equal(updates.length, 1);
  assert.equal(disposals, 1);
  assert.deepEqual(errors, []);
});

test('remote requests are typed, server-bound, cursor-bounded and never use local hosting', async () => {
  const f = remoteFixture();
  const source = f.create();
  const first = source.read();
  assert.equal(f.requests[0].type, MessageType.SERVER_MONITOR_GET);
  assert.deepEqual(f.requests[0].payload, { serverId: 'server-a', cursor: undefined });
  assert.equal(f.requests[0].timeout, SERVER_MONITOR_LIMITS.REQUEST_TIMEOUT_MS);
  f.requests[0].result.resolve(snapshot());
  assert.equal((await first).replaceLogs, true);
  const second = source.read();
  assert.deepEqual(f.requests[1].payload, { serverId: 'server-a', cursor: 1 });
  f.requests[1].result.resolve(snapshot(2));
  assert.equal((await second).replaceLogs, false);
  source.dispose();
  assert.deepEqual(f.cancelled, f.requests.map((request) => request.id), 'completed requests are retired against late duplicate frames');
});

test('closing and reopening while an old request is pending cannot populate the new opening', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = remoteFixture();
  const oldUpdates: MonitorUpdate[] = [];
  const newUpdates: MonitorUpdate[] = [];
  const errors: unknown[] = [];
  const oldFeed = new ServerMonitorFeed(f.create(), (value) => oldUpdates.push(value), (error) => errors.push(error));
  const oldOpening = oldFeed.start();
  oldFeed.stop();
  assert.deepEqual(f.cancelled, [f.requests[0].id]);
  const newFeed = new ServerMonitorFeed(f.create(), (value) => newUpdates.push(value), (error) => errors.push(error));
  const newOpening = newFeed.start();
  assert.notEqual(f.requests[0].id, f.requests[1].id);
  f.requests[0].result.resolve(snapshot(99));
  await oldOpening;
  assert.equal(newUpdates.length, 0);
  f.requests[1].result.resolve(snapshot(2));
  await newOpening;
  assert.deepEqual(newUpdates[0].entries, snapshot(2).entries);
  newFeed.stop();
  t.mock.timers.tick(30_000);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(oldUpdates, []);
  assert.deepEqual(errors, []);
});

test('revocation cancels an open monitor without disconnecting or silently restoring access', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = remoteFixture();
  const updates: MonitorUpdate[] = [];
  const errors: unknown[] = [];
  const feed = new ServerMonitorFeed(f.create(), (value) => updates.push(value), (error) => errors.push(error));
  const opening = feed.start();
  f.permission(0);
  feed.revalidate();
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof ServerMonitorError);
  assert.equal(errors[0].reason, 'permissionDenied');
  assert.deepEqual(f.cancelled, [f.requests[0].id]);
  f.requests[0].result.resolve(snapshot());
  await opening;
  f.permission(Permission.VIEW_SERVER_MONITOR);
  feed.revalidate();
  t.mock.timers.tick(30_000);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(updates, []);
});

test('administrator is allowed; MANAGE_SERVER alone, no grant and bots are refused before a request', async () => {
  for (const permissions of [0, Permission.MANAGE_SERVER]) {
    const f = remoteFixture();
    f.permission(permissions);
    assert.throws(() => f.create().assertCurrent(), { reason: 'permissionDenied' });
    assert.equal(f.requests.length, 0);
  }
  const admin = remoteFixture();
  admin.permission(Permission.ADMINISTRATOR);
  admin.create().assertCurrent();
  admin.store.currentUser.isBot = true;
  assert.throws(() => admin.create().assertCurrent(), { reason: 'permissionDenied' });
});

test('session, socket and authenticated identity changes invalidate responses across awaits', async () => {
  for (const change of ['disconnect', 'replaceConnection', 'switchServer', 'serverId', 'userId', 'sessionId'] as const) {
    const f = remoteFixture();
    const source = f.create();
    const request = source.read();
    if (change === 'serverId') f.store.serverDetails.id = 'server-b';
    else if (change === 'userId') f.store.currentUser.id = 'other';
    else if (change === 'sessionId') f.store.currentUser.sessionId = 'other-device';
    else f[change]();
    f.requests[0].result.resolve(snapshot());
    await assert.rejects(request, ServerMonitorError);
    source.dispose();
  }
});

test('cross-server, oversized, private-field and stale snapshots are explicit failures', async () => {
  const invalid: unknown[] = [
    { ...snapshot(), serverId: 'server-b' },
    { ...snapshot(), stats: { ...stats, dataDir: 'private-host-path' } },
    { ...snapshot(), entries: Array.from({ length: SERVER_MONITOR_LIMITS.MAX_BATCH_ENTRIES + 1 }, (_, i) => ({ ...log, sequence: i })) },
    { ...snapshot(), entries: [{ ...log, sequence: 1, message: 'x'.repeat(SERVER_MONITOR_LIMITS.MAX_MESSAGE_LENGTH + 1) }] },
    { ...snapshot(), entries: [{ ...log, sequence: 1, timestamp: `2026-09-14T13:00:00.${'0'.repeat(2000)}Z` }] },
    { ...snapshot(), entries: [{ ...log, sequence: 2 }, { ...log, sequence: 1 }] },
  ];
  for (const payload of invalid) {
    const f = remoteFixture();
    const source = f.create();
    const request = source.read();
    f.requests[0].result.resolve(payload);
    await assert.rejects(request, { reason: 'invalidResponse' });
    source.dispose();
  }
  const f = remoteFixture();
  const source = f.create();
  const first = source.read();
  f.requests[0].result.resolve(snapshot(2));
  await first;
  const stale = source.read();
  f.requests[1].result.resolve(snapshot(1));
  await assert.rejects(stale, { reason: 'invalidResponse' });
  source.dispose();
});

test('request failures are reported once and do not restart polling or manufacture empty success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = remoteFixture();
  const updates: MonitorUpdate[] = [];
  const errors: unknown[] = [];
  const feed = new ServerMonitorFeed(f.create(), (value) => updates.push(value), (error) => errors.push(error));
  const opening = feed.start();
  const failure = new Error('Server refused the request');
  f.requests[0].result.reject(failure);
  await opening;
  t.mock.timers.tick(30_000);
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(updates, []);
  assert.equal(f.requests.length, 1);
});

function localFixture() {
  const logListeners = new Set<(entry: LogEntry) => void>();
  const statusListeners = new Set<Parameters<LocalMonitorApi['onHostServerStatusChanged']>[0]>();
  let status = { isRunning: true, port: 3000, serverId: 'local-a' };
  const localStats: ServerStats = { ...stats, dataDir: 'local-server-directory' };
  let readStats = async (): Promise<ServerStats | null> => ({ ...localStats });
  let history: LogEntry[] = [];
  const api: LocalMonitorApi = {
    hostServerStatus: async () => ({ ...status }),
    hostServerStats: () => readStats(),
    hostServerLogs: async () => history,
    onHostServerLog: (listener) => { logListeners.add(listener); return () => { logListeners.delete(listener); }; },
    onHostServerStatusChanged: (listener) => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
  };
  return {
    api, logListeners, statusListeners,
    stats: (read: typeof readStats) => { readStats = read; },
    history: (entries: LogEntry[]) => { history = entries; },
    log: (entry: LogEntry) => { for (const listener of logListeners) listener(entry); },
    stop: () => {
      status = { ...status, isRunning: false };
      for (const listener of statusListeners) listener(status);
    },
  };
}

test('local history buffers live entries during loading and removes every IPC listener on close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = localFixture();
  const gate = deferred<ServerStats | null>();
  f.stats(() => gate.promise);
  f.history([log]);
  const updates: MonitorUpdate[] = [];
  const errors: unknown[] = [];
  const feed = new ServerMonitorFeed(new LocalServerMonitorSource(f.api), (value) => updates.push(value), (error) => errors.push(error));
  const opening = feed.start();
  await flush();
  f.log(log);
  f.log(log);
  const next = { ...log, message: 'Next event' };
  f.log(next);
  gate.resolve({ ...stats, dataDir: 'local-a' });
  await opening;
  assert.deepEqual(updates[0].entries, [log, log, next], 'history/live overlap is deduplicated, not repeated log events');
  f.stats(async () => ({ ...stats, dataDir: 'local-a' }));
  for (let index = 0; index < 700; index++) f.log({ ...log, message: String(index) });
  t.mock.timers.tick(SERVER_MONITOR_LIMITS.POLL_INTERVAL_MS);
  await flush();
  assert.equal(updates[1].entries.length, SERVER_MONITOR_LIMITS.HISTORY_ENTRIES);
  assert.equal(updates[1].dropped, 200);
  assert.equal(updates[1].replaceLogs, false);
  feed.stop();
  assert.equal(f.logListeners.size, 0);
  assert.equal(f.statusListeners.size, 0);
  assert.deepEqual(errors, []);
});

test('stopping a local host while loading removes listeners immediately and rejects late data', async () => {
  const f = localFixture();
  const gate = deferred<ServerStats | null>();
  f.stats(() => gate.promise);
  const updates: MonitorUpdate[] = [];
  const errors: unknown[] = [];
  const feed = new ServerMonitorFeed(new LocalServerMonitorSource(f.api), (value) => updates.push(value), (error) => errors.push(error));
  const opening = feed.start();
  await flush();
  f.stop();
  assert.equal(f.logListeners.size, 0);
  assert.equal(f.statusListeners.size, 0);
  gate.resolve({ ...stats, dataDir: 'local-a' });
  await opening;
  assert.deepEqual(updates, []);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof ServerMonitorError);
  assert.equal(errors[0].reason, 'localStopped');
});

test('local monitoring without a bridge or running host fails explicitly', async () => {
  const unavailable = new LocalServerMonitorSource(undefined);
  await assert.rejects(unavailable.read(), { reason: 'localUnavailable' });
  const f = localFixture();
  f.stop();
  const stopped = new LocalServerMonitorSource(f.api);
  await assert.rejects(stopped.read(), { reason: 'localStopped' });
  stopped.dispose();
});

test('a local stop event cleans up even before the initial host-status request answers', async () => {
  const f = localFixture();
  const gate = deferred<Awaited<ReturnType<LocalMonitorApi['hostServerStatus']>>>();
  f.api.hostServerStatus = () => gate.promise;
  const updates: MonitorUpdate[] = [];
  const errors: unknown[] = [];
  const feed = new ServerMonitorFeed(new LocalServerMonitorSource(f.api), (value) => updates.push(value), (error) => errors.push(error));
  const opening = feed.start();
  f.stop();
  assert.equal(f.logListeners.size, 0);
  assert.equal(f.statusListeners.size, 0);
  assert.equal(errors.length, 1);
  gate.resolve({ isRunning: true, port: 3000, serverId: 'local-a' });
  await opening;
  assert.deepEqual(updates, []);
});
