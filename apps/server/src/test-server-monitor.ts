import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import {
  DEFAULT_PERMISSIONS, MessageType, Permission, PROTOCOL_VERSION, ProtocolErrorCode,
  SERVER_MONITOR_LIMITS, hasPermission, roleCreateSchema, serverMonitorGetSchema,
  serverMonitorSnapshotSchema, stripAdministrator,
  type LogEntry, type ProtocolMessage, type ServerErrorPayload, type ServerMonitorSnapshotPayload, type ServerStats,
} from '@monky/shared';
import { ServerMonitorService } from './application/services/ServerMonitorService';
import { PermissionService } from './application/services/PermissionService';
import { LanBroadcaster } from './infrastructure/discovery/LanBroadcaster';
import { Logger } from './infrastructure/logger/Logger';
import { ServerLogScope, remoteLogMessage } from './infrastructure/logger/ServerLogScope';
import { RateLimiter } from './infrastructure/security/RateLimiter';
import { ServerMonitorHandler, type ServerMonitorSession } from './infrastructure/websocket/ServerMonitorHandler';
import { MonkyServer } from './server';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const stats: ServerStats = {
  serverName: 'Scoped A', dataDir: 'private-host-directory', port: 3000, startedAt: 1000, uptimeMs: 1000,
  onlineUsers: 2, maxUsers: 10, members: 3, channels: 2, messages: 4,
};
const entry: LogEntry = {
  timestamp: '2026-09-14T13:00:00.000Z', level: 'INFO', category: 'NETWORK', message: 'New connection established from private-address',
};

function fixture(t: TestContext) {
  const scope = new ServerLogScope();
  const limiter = new RateLimiter();
  const current = new Set<ServerMonitorSession>();
  const responses: Array<{ session: ServerMonitorSession; message: ProtocolMessage<ServerMonitorSnapshotPayload | ServerErrorPayload> }> = [];
  const permissions = new Map<string, number>();
  let version = 0;
  let reads = 0;
  let readStats = async () => ({ ...stats });
  let permissionHook: (() => Promise<void>) | undefined;
  const service = new ServerMonitorService('server-a', scope, () => { reads++; return readStats(); }, limiter);
  const handler = new ServerMonitorHandler(service, {
    getRoleAccessVersion: () => version,
    checkPermission: async (userId, permission) => {
      const bits = permissions.get(userId) ?? DEFAULT_PERMISSIONS;
      const hook = permissionHook;
      permissionHook = undefined;
      await hook?.();
      return hasPermission(bits, permission);
    },
  }, {
    isCurrent: (session) => current.has(session),
    accessVersion: () => version,
    send: (session, message) => responses.push({ session, message }),
  });
  const session = (id: string, bits = DEFAULT_PERMISSIONS, isBot = false): ServerMonitorSession => {
    const socket: unknown = Reflect.construct(WebSocket, [null, undefined, { autoPong: true, closeTimeout: 0 }]);
    assert.ok(socket instanceof WebSocket);
    const result: ServerMonitorSession = {
      ws: socket, sessionId: `${id}:device`, isBot,
      user: { id, clientId: id, nickname: id, status: 'ONLINE', joinedAt: 1, isBot },
    };
    permissions.set(id, bits);
    current.add(result);
    return result;
  };
  let request = 0;
  const call = async (target: ServerMonitorSession, payload: unknown = { serverId: 'server-a' }) => {
    const requestId = `monitor-${request++}`;
    await handler.handle(target, payload, requestId);
    return responses.find((response) => response.message.requestId === requestId)?.message;
  };
  t.after(() => { handler.close(); scope.close(); limiter.dispose(); });
  return {
    scope, limiter, service, handler, current, permissions, responses, session, call,
    reads: () => reads,
    stats: (reader: typeof readStats) => { readStats = reader; },
    racePermission: (hook: () => Promise<void>) => { permissionHook = hook; },
    revoke: (id: string) => { permissions.set(id, 0); version++; },
    bumpVersion: () => { version++; },
  };
}

function errorCode(message: ProtocolMessage<unknown> | undefined): unknown {
  assert.equal(message?.type, MessageType.SERVER_ERROR);
  assert.ok(message);
  return record(message.payload).code;
}

test('monitor permission is explicit, preserves normalization and never grants management', () => {
  assert.equal(hasPermission(DEFAULT_PERMISSIONS, Permission.VIEW_SERVER_MONITOR), false);
  assert.equal(hasPermission(Permission.MANAGE_SERVER, Permission.VIEW_SERVER_MONITOR), false);
  assert.equal(hasPermission(Permission.ADMINISTRATOR, Permission.VIEW_SERVER_MONITOR), true);
  const parsed = roleCreateSchema.parse({
    name: 'Monitor viewers', permissions: Permission.VIEW_SERVER_MONITOR | Permission.ADMINISTRATOR,
  });
  const normalized = stripAdministrator(parsed.permissions);
  assert.equal(normalized, Permission.VIEW_SERVER_MONITOR);
  assert.equal(hasPermission(normalized, Permission.MANAGE_SERVER), false);
  assert.equal(hasPermission(normalized, Permission.MANAGE_ROLES), false);
});

test('monitor handler authorizes administrators and explicit viewers, but never ungranted humans or bots', async (t) => {
  const f = fixture(t);
  for (const bits of [Permission.ADMINISTRATOR, Permission.VIEW_SERVER_MONITOR]) {
    const response = await f.call(f.session(`allowed-${bits}`, bits));
    assert.equal(response?.type, MessageType.SERVER_MONITOR_SNAPSHOT);
    const result = serverMonitorSnapshotSchema.parse(response?.payload);
    assert.equal(result.serverId, 'server-a');
    assert.equal('dataDir' in result.stats, false);
  }
  for (const bits of [DEFAULT_PERMISSIONS, Permission.MANAGE_SERVER, 0]) {
    assert.equal(errorCode(await f.call(f.session(`denied-${bits}`, bits))), ProtocolErrorCode.PERMISSION_DENIED);
  }
  assert.equal(errorCode(await f.call(f.session('admin-bot', Permission.ADMINISTRATOR, true))), ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(f.reads(), 2, 'denied requests never call the stats provider');
});

test('monitor rejects foreign server IDs, forged fields, malformed cursors and missing correlation', async (t) => {
  const f = fixture(t);
  const viewer = f.session('viewer', Permission.VIEW_SERVER_MONITOR);
  assert.equal(errorCode(await f.call(viewer, { serverId: 'server-b' })), ProtocolErrorCode.PERMISSION_DENIED);
  for (const payload of [
    { serverId: 'server-a', userId: 'owner' }, { serverId: 'server-a', cursor: -1 },
    { serverId: 'server-a', cursor: 0.5 }, { serverId: 'server-a', cursor: 99 }, {},
  ]) {
    assert.equal(errorCode(await f.call(viewer, payload)), ProtocolErrorCode.BAD_REQUEST);
  }
  await f.handler.handle(viewer, { serverId: 'server-a' });
  assert.equal(errorCode(f.responses.at(-1)?.message), ProtocolErrorCode.BAD_REQUEST);
  assert.equal(f.reads(), 0);
  assert.equal(serverMonitorGetSchema.safeParse({ serverId: 'server-a', cursor: Number.MAX_SAFE_INTEGER + 1 }).success, false);
});

test('revocation during stats or final permission lookup cannot publish a stale snapshot', async (t) => {
  for (const phase of ['stats', 'final-permission']) {
    const f = fixture(t);
    const viewer = f.session(`viewer-${phase}`, Permission.VIEW_SERVER_MONITOR);
    const gate = deferred<void>();
    f.stats(async () => {
      if (phase === 'stats') await gate.promise;
      else f.racePermission(async () => { f.revoke(viewer.user!.id); });
      return { ...stats };
    });
    const request = f.call(viewer);
    await flush();
    if (phase === 'stats') { f.revoke(viewer.user!.id); gate.resolve(); }
    assert.equal(errorCode(await request), ProtocolErrorCode.PERMISSION_DENIED);
    assert.equal(f.current.has(viewer), true, 'revoking viewing does not disconnect the participant');
    assert.equal(f.responses.some((response) => response.message.type === MessageType.SERVER_MONITOR_SNAPSHOT), false);
  }
});

test('socket, identity, session and shutdown binding is captured across awaited work', async (t) => {
  for (const change of ['disconnect', 'socket', 'user', 'user-id', 'session', 'shutdown']) {
    const f = fixture(t);
    const viewer = f.session(`viewer-${change}`, Permission.VIEW_SERVER_MONITOR);
    const gate = deferred<void>();
    f.stats(async () => { await gate.promise; return { ...stats }; });
    const request = f.call(viewer);
    await flush();
    if (change === 'disconnect') f.current.delete(viewer);
    else if (change === 'socket') viewer.ws = f.session('replacement-socket').ws;
    else if (change === 'user') viewer.user = f.session('replacement-user').user;
    else if (change === 'user-id') { assert.ok(viewer.user); viewer.user.id = 'replacement-id'; }
    else if (change === 'session') viewer.sessionId = 'replacement-session';
    else f.handler.close();
    gate.resolve();
    assert.equal(await request, undefined);
    assert.equal(f.responses.length, 0);
  }
});

test('a profile refresh of the same authenticated identity does not cancel monitoring', async (t) => {
  const f = fixture(t);
  const viewer = f.session('viewer', Permission.VIEW_SERVER_MONITOR);
  const gate = deferred<void>();
  f.stats(async () => { await gate.promise; return { ...stats }; });
  const request = f.call(viewer);
  await flush();
  assert.ok(viewer.user);
  viewer.user = { ...viewer.user, nickname: 'Updated nickname' };
  gate.resolve();
  assert.equal((await request)?.type, MessageType.SERVER_MONITOR_SNAPSHOT);
});

test('monitor rate limits and in-flight guard bound database work independently of chat traffic', async (t) => {
  const f = fixture(t);
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  const viewer = f.session('viewer', Permission.VIEW_SERVER_MONITOR);
  assert.equal((await f.call(viewer))?.type, MessageType.SERVER_MONITOR_SNAPSHOT);
  assert.equal((await f.call(viewer))?.type, MessageType.SERVER_MONITOR_SNAPSHOT);
  assert.equal(errorCode(await f.call(viewer)), ProtocolErrorCode.RATE_LIMITED);
  assert.equal(f.reads(), 2);
  assert.equal(f.limiter.checkLimit('viewer'), true, 'monitor reads do not consume the chat allowance');
  now += SERVER_MONITOR_LIMITS.RATE_WINDOW_MS;
  const gate = deferred<void>();
  f.stats(async () => { await gate.promise; return { ...stats }; });
  const pending = f.call(viewer);
  await flush();
  assert.equal(errorCode(await f.call(viewer)), ProtocolErrorCode.RATE_LIMITED);
  gate.resolve();
  assert.equal((await pending)?.type, MessageType.SERVER_MONITOR_SNAPSHOT);
  assert.equal(f.reads(), 3);
});

test('aggregate monitor traffic is bounded across different authenticated users', async (t) => {
  const f = fixture(t);
  t.mock.method(Date, 'now', () => 10_000);
  for (let index = 0; index < SERVER_MONITOR_LIMITS.TOTAL_REQUESTS_PER_SECOND; index++) {
    assert.equal((await f.call(f.session(`viewer-${index}`, Permission.VIEW_SERVER_MONITOR)))?.type, MessageType.SERVER_MONITOR_SNAPSHOT);
  }
  assert.equal(errorCode(await f.call(f.session('overflow-viewer', Permission.VIEW_SERVER_MONITOR))), ProtocolErrorCode.RATE_LIMITED);
  assert.equal(f.reads(), SERVER_MONITOR_LIMITS.TOTAL_REQUESTS_PER_SECOND);
});

test('stats failures propagate and release in-flight state without inventing an empty snapshot', async (t) => {
  const f = fixture(t);
  const viewer = f.session('viewer', Permission.VIEW_SERVER_MONITOR);
  const failure = new Error('Stats database unavailable');
  f.stats(async () => { throw failure; });
  await assert.rejects(f.call(viewer), failure);
  assert.deepEqual(f.responses, []);
  f.stats(async () => ({ ...stats }));
  assert.equal((await f.call(viewer))?.type, MessageType.SERVER_MONITOR_SNAPSHOT);
});

test('remote log history is scoped, deny-by-default, bounded and never includes metadata or unrelated process data', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const first = new ServerLogScope();
  const second = new ServerLogScope();
  t.after(() => { first.close(); second.close(); });
  const gate = deferred<void>();
  const pending = Logger.withScope(first, async () => {
    Logger.info('NETWORK', 'New connection established from password=private-value', { token: 'private-token' });
    await gate.promise;
    Logger.error('NETWORK', 'Failed to process message', new Error('https://signed.example/file?token=private-token'));
  });
  Logger.withScope(second, () => Logger.info('INFO', 'Monky Server running on 0.0.0.0:3001'));
  Logger.info('NETWORK', 'New connection established from unrelated-process');
  gate.resolve();
  await pending;
  assert.equal(first.read().entries.length, 2);
  assert.equal(second.read().entries.length, 1);
  const serialized = JSON.stringify(first.read());
  for (const secret of ['private-value', 'private-token', 'signed.example', 'unrelated-process']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(remoteLogMessage('arbitrary private chat text'), remoteLogMessage('token=secret'));
  assert.equal(remoteLogMessage('[coturn] private signed URL'), remoteLogMessage('token=secret'));
  assert.equal(remoteLogMessage('x'.repeat(100_000)), remoteLogMessage('token=secret'));
  for (let index = 0; index < 1000; index++) first.record(entry, entry.message);
  const batch = first.read();
  assert.equal(batch.entries.length, SERVER_MONITOR_LIMITS.MAX_BATCH_ENTRIES);
  assert.equal(batch.dropped, SERVER_MONITOR_LIMITS.HISTORY_ENTRIES - SERVER_MONITOR_LIMITS.MAX_BATCH_ENTRIES);
  assert.equal(first.read(batch.cursor).entries.length, 0);
  assert.equal(first.read(0).dropped, 1002 - SERVER_MONITOR_LIMITS.MAX_BATCH_ENTRIES);
  assert.ok(Buffer.byteLength(JSON.stringify(batch), 'utf8') < 32_000);
  batch.entries[0].message = 'mutated by caller';
  assert.notEqual(first.read().entries[0].message, 'mutated by caller');
  assert.throws(() => first.read(1003), RangeError);
  first.close();
  assert.throws(() => first.read(), /stopped/);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function text(value: unknown): string {
  assert.equal(typeof value, 'string');
  assert.ok(typeof value === 'string');
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
function parseMessage(data: string): ProtocolMessage<unknown> {
  const message = record(JSON.parse(data));
  const type = Object.values(MessageType).find((value) => value === message.type);
  assert.ok(type);
  return { type, requestId: message.requestId === undefined ? undefined : text(message.requestId), payload: message.payload };
}
function identity() {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('hex') };
}

class MonitorPeer {
  private readonly listeners = new Set<(message: ProtocolMessage<unknown>) => void>();
  readonly messages: ProtocolMessage<unknown>[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = parseMessage(data.toString());
      this.messages.push(message);
      for (const listener of this.listeners) listener(message);
    });
  }

  request(type: MessageType, payload: unknown = {}): Promise<ProtocolMessage<unknown>> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const listener = (message: ProtocolMessage<unknown>) => {
        if (message.requestId !== requestId) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out waiting for ${type}.`));
      }, 5000);
      this.listeners.add(listener);
      this.ws.send(JSON.stringify({ type, payload, requestId }));
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = once(this.ws, 'close');
    this.ws.terminate();
    await closed;
  }
}

async function realServer(t: TestContext, name: string) {
  const dataDir = path.join(__dirname, '..', `.monitor-test-${process.pid}-${randomUUID()}`);
  const peers: MonitorPeer[] = [];
  let server: MonkyServer | undefined;
  t.after(async () => {
    try {
      for (const peer of peers) await peer.close();
      await server?.stop();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  server = await MonkyServer.create({ dataDir, port: 0, discoveryPort: 0, serverName: name, maxUsers: 20, voiceMode: 'p2p' });
  await server.start();
  const port = (await server.getStats()).port;
  assert.ok(port > 0);
  const connect = async () => {
    const peer = new MonitorPeer(new WebSocket(`ws://127.0.0.1:${port}`));
    peers.push(peer);
    await once(peer.ws, 'open');
    return peer;
  };
  const human = async (nickname: string) => {
    const peer = await connect();
    const keys = identity();
    const challenge = await peer.request(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION, nickname, publicKey: keys.publicKey, deviceId: randomUUID(),
    });
    assert.equal(challenge.type, MessageType.AUTH_CHALLENGE);
    const signature = sign(null, Buffer.from(text(record(challenge.payload).nonce), 'hex'), keys.privateKey).toString('hex');
    const auth = await peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, { signature });
    assert.equal(auth.type, MessageType.AUTH_SUCCESS);
    const payload = record(auth.payload);
    const details = record(payload.server);
    return { peer, id: text(record(payload.currentUser).id), serverId: text(details.id), details };
  };
  return { server, human, connect, port };
}

async function createRole(owner: MonitorPeer, name: string, permissions: number): Promise<Record<string, unknown>> {
  const result = await owner.request(MessageType.ROLE_CREATE, { name, permissions });
  assert.equal(result.type, MessageType.ROLES_LIST);
  const role = records(record(result.payload).roles).find((entry) => entry.name === name);
  assert.ok(role);
  return role;
}

test('real authenticated WebSocket: owner/admin and granted users can view VPS-style stats, while managers and bots cannot', { timeout: 60_000 }, async (t) => {
  t.mock.method(LanBroadcaster.prototype, 'start', async () => {});
  const f = await realServer(t, 'Remote monitor A');
  const owner = await f.human('Monitor owner');
  const admin = await f.human('Monitor admin');
  const viewer = await f.human('Monitor viewer');
  const manager = await f.human('Manager only');
  const adminRole = records(owner.details.roles).find((role) => role.name === 'Admin');
  assert.ok(adminRole);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: admin.id, roleId: text(adminRole.id) });
  const viewerRole = await createRole(owner.peer, 'Monitor readers', Permission.VIEW_SERVER_MONITOR | Permission.ADMINISTRATOR);
  assert.equal(viewerRole.permissions, Permission.VIEW_SERVER_MONITOR, 'normal role editing strips administrator but preserves viewing');
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: viewer.id, roleId: text(viewerRole.id) });
  const managerRole = await createRole(owner.peer, 'Server managers', Permission.MANAGE_SERVER);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: manager.id, roleId: text(managerRole.id) });
  for (const allowed of [owner, admin, viewer]) {
    const response = await allowed.peer.request(MessageType.SERVER_MONITOR_GET, { serverId: owner.serverId });
    assert.equal(response.type, MessageType.SERVER_MONITOR_SNAPSHOT);
    const result = serverMonitorSnapshotSchema.parse(response.payload);
    assert.equal(result.stats.serverName, 'Remote monitor A');
    assert.equal(result.stats.port, f.port);
    assert.equal(result.stats.onlineUsers, 4);
    assert.equal(result.stats.members, 4);
    assert.equal('dataDir' in result.stats, false);
    assert.ok(result.entries.some((log) => log.message === 'Monky Server is listening.'), 'socket requests use the running server log scope');
  }
  assert.equal(errorCode(await manager.peer.request(MessageType.SERVER_MONITOR_GET, { serverId: owner.serverId })), ProtocolErrorCode.PERMISSION_DENIED);
  const ungranted = await f.human('Ordinary member');
  assert.equal(errorCode(await ungranted.peer.request(MessageType.SERVER_MONITOR_GET, { serverId: owner.serverId })), ProtocolErrorCode.PERMISSION_DENIED);
  const anonymous = await f.connect();
  assert.equal(errorCode(await anonymous.request(MessageType.SERVER_MONITOR_GET, { serverId: owner.serverId })), ProtocolErrorCode.UNAUTHORIZED);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  assert.equal(created.type, MessageType.BOT_CREATED);
  const bot = await f.connect();
  const botAuth = await bot.request(MessageType.AUTH_CONNECT, {
    protocolVersion: PROTOCOL_VERSION, nickname: 'Monitor bot', publicKey: identity().publicKey,
    botToken: text(record(created.payload).token),
  });
  assert.equal(botAuth.type, MessageType.AUTH_SUCCESS);
  assert.equal(errorCode(await bot.request(MessageType.SERVER_MONITOR_GET, { serverId: owner.serverId })), ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/server-monitor`)).status, 404);

  const captured = deferred<void>();
  const release = deferred<void>();
  const original = ServerMonitorService.prototype.getSnapshot;
  const delayed = t.mock.method(ServerMonitorService.prototype, 'getSnapshot', async function (this: ServerMonitorService, cursor?: number) {
    const result = await original.call(this, cursor);
    captured.resolve();
    await release.promise;
    return result;
  });
  const request = viewer.peer.request(MessageType.SERVER_MONITOR_GET, { serverId: owner.serverId });
  try {
    await captured.promise;
    const revoke = await owner.peer.request(MessageType.ROLE_UPDATE, { roleId: text(viewerRole.id), permissions: 0 });
    assert.equal(revoke.type, MessageType.ROLES_LIST);
    release.resolve();
    assert.equal(errorCode(await request), ProtocolErrorCode.PERMISSION_DENIED);
    assert.equal(viewer.peer.ws.readyState, WebSocket.OPEN, 'revocation must not force a disconnect');
    assert.equal((await viewer.peer.request(MessageType.PING)).type, MessageType.PONG);
  } finally {
    release.resolve();
    delayed.mock.restore();
  }
});

test('two servers in one process never share monitor history or accept each other server IDs', { timeout: 60_000 }, async (t) => {
  t.mock.method(LanBroadcaster.prototype, 'start', async () => {});
  const first = await realServer(t, 'Scope A');
  const alice = await first.human('Alice owner');
  const before = serverMonitorSnapshotSchema.parse((await alice.peer.request(MessageType.SERVER_MONITOR_GET, { serverId: alice.serverId })).payload);
  const second = await realServer(t, 'Scope B');
  const bob = await second.human('Bob owner');
  const visitor = await second.human('Only on B');
  Logger.info('NETWORK', 'New connection established from unrelated process data');
  const after = serverMonitorSnapshotSchema.parse((await alice.peer.request(
    MessageType.SERVER_MONITOR_GET, { serverId: alice.serverId, cursor: before.cursor },
  )).payload);
  assert.equal(after.cursor, before.cursor, 'creating and using server B cannot add to server A history');
  assert.deepEqual(after.entries, []);
  assert.equal(after.stats.onlineUsers, 1);
  assert.equal(errorCode(await bob.peer.request(MessageType.SERVER_MONITOR_GET, { serverId: alice.serverId })), ProtocolErrorCode.PERMISSION_DENIED);
  const remoteB = serverMonitorSnapshotSchema.parse((await bob.peer.request(MessageType.SERVER_MONITOR_GET, { serverId: bob.serverId })).payload);
  assert.equal(remoteB.stats.serverName, 'Scope B');
  assert.equal(remoteB.stats.onlineUsers, 2);
  assert.equal(JSON.stringify(remoteB).includes('unrelated process data'), false);
  assert.equal(JSON.stringify(remoteB).includes(visitor.id), false, 'remote operational logs omit private identifiers');
  assert.notEqual(remoteB.serverId, after.serverId);
});

test('a committed role revocation cannot leak through the gap before its WebSocket role broadcast', { timeout: 60_000 }, async (t) => {
  t.mock.method(LanBroadcaster.prototype, 'start', async () => {});
  const f = await realServer(t, 'Revocation boundary');
  const owner = await f.human('Role owner');
  const viewer = await f.human('Revoked viewer');
  const role = await createRole(owner.peer, 'Monitor permission', Permission.VIEW_SERVER_MONITOR);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: viewer.id, roleId: text(role.id) });
  const authorized = deferred<void>();
  const finishAuthorization = deferred<void>();
  const written = deferred<void>();
  const finishWrite = deferred<void>();
  let checks = 0;
  const originalCheck = PermissionService.prototype.checkPermission;
  const check = t.mock.method(PermissionService.prototype, 'checkPermission', async function (
    this: PermissionService, userId: string, permission: Permission,
  ) {
    const allowed = await originalCheck.call(this, userId, permission);
    if (userId === viewer.id && permission === Permission.VIEW_SERVER_MONITOR && ++checks === 2) {
      authorized.resolve();
      await finishAuthorization.promise;
    }
    return allowed;
  });
  const wsServer = f.server['wsServer'];
  const repo = wsServer['roleService']['roleRepo'];
  const originalUpdate = repo.update.bind(repo);
  const updateRole = t.mock.method(repo, 'update', async (roleId: string, updates: Parameters<typeof repo.update>[1]) => {
    await originalUpdate(roleId, updates);
    written.resolve();
    await finishWrite.promise;
  });
  const pending = viewer.peer.request(MessageType.SERVER_MONITOR_GET, { serverId: owner.serverId });
  try {
    await authorized.promise;
    const broadcastVersion = wsServer['botSettingsPermissionVersion'];
    const revoking = owner.peer.request(MessageType.ROLE_UPDATE, { roleId: text(role.id), permissions: 0 });
    await written.promise;
    assert.equal(wsServer['botSettingsPermissionVersion'], broadcastVersion, 'the role broadcast has not happened yet');
    assert.equal(wsServer['permissionService'].getRoleAccessVersion(), null, 'the actual role write is guarded');
    finishAuthorization.resolve();
    assert.equal(errorCode(await pending), ProtocolErrorCode.PERMISSION_DENIED, 'the previously allowed lookup is stale');
    finishWrite.resolve();
    assert.equal((await revoking).type, MessageType.ROLES_LIST);
    assert.notEqual(wsServer['permissionService'].getRoleAccessVersion(), null);
    assert.equal(viewer.peer.ws.readyState, WebSocket.OPEN);
  } finally {
    finishAuthorization.resolve();
    finishWrite.resolve();
    check.mock.restore();
    updateRole.mock.restore();
  }
});
