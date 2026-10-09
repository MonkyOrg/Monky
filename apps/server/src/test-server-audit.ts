import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import {
  DEFAULT_PERMISSIONS, MessageType, PROTOCOL_VERSION, Permission, ProtocolErrorCode, SERVER_AUDIT_ACTIVITY_ACTIONS,
  SERVER_AUDIT_LIMITS,
  hasPermission, serverAuditPageSchema,
  type ProtocolMessage, type ServerAuditEntry, type ServerAuditPagePayload, type ServerErrorPayload,
} from '@monky/shared';
import { ServerAuditService } from './application/services/ServerAuditService';
import {
  channelChanges, channelTreeMoves, movedItems, permissionChanges, serverSettingsChanges,
} from './application/services/serverAuditChanges';
import type { ServerRecord } from './domain/entities';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqliteServerAuditRepository } from './infrastructure/database/SqliteServerAuditRepository';
import { LanBroadcaster } from './infrastructure/discovery/LanBroadcaster';
import { RateLimiter } from './infrastructure/security/RateLimiter';
import { ServerAuditHandler, type ServerAuditSession } from './infrastructure/websocket/ServerAuditHandler';
import { MonkyServer } from './server';

const DAY = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === 'string');
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

async function database(t: TestContext) {
  const dir = path.join(__dirname, '..', `.audit-test-${process.pid}-${randomUUID()}`);
  const connection = await DatabaseConnection.create(path.join(dir, 'server.db'));
  t.after(() => {
    connection.close({ discardChanges: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return new SqliteServerAuditRepository(connection.getDb());
}

async function service(t: TestContext, now: () => number = Date.now) {
  const limiter = new RateLimiter();
  t.after(() => limiter.dispose());
  const repository = await database(t);
  return { repository, limiter, audit: new ServerAuditService('server-a', repository, limiter, now) };
}

const admin = { type: 'user', id: 'admin', name: 'Admin' };

test('moves name only what was dragged, not everything it shifted', () => {
  assert.deepEqual(movedItems(['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'b']), [{ id: 'b', from: 2, to: 4 }]);
  assert.deepEqual(movedItems(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c']), [{ id: 'd', from: 4, to: 1 }]);
  assert.deepEqual(movedItems(['a', 'b'], ['a', 'b']), []);
  assert.equal(movedItems(['a', 'b', 'c'], ['a', 'x', 'c', 'b']).some(move => move.id === 'x'), false,
    'new items are never reported as moves');

  const channel = (id: string, position: number, categoryId: string | null = null) => ({
    id, name: id, serverId: 's', type: 'TEXT' as const, position, createdAt: 1, categoryId,
    isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true,
  });
  const category = (id: string, position: number) => ({ id, name: id.toUpperCase(), serverId: 's', position, createdAt: 1, isPrivate: false, allowedRoleIds: [] });
  const moves = channelTreeMoves(
    { channels: [channel('general', 0), channel('one', 0, 'cat'), channel('two', 1, 'cat')], categories: [category('cat', 1)] },
    { channels: [channel('general', 1), channel('one', 1, 'cat'), channel('two', 0, 'cat')], categories: [category('cat', 0)] },
  );
  assert.deepEqual(moves, [
    { target: { type: 'category', id: 'cat', name: 'CAT' }, container: null, from: 2, to: 1 },
    { target: { type: 'channel', id: 'two', name: 'two' }, container: { type: 'category', id: 'cat', name: 'CAT' }, from: 2, to: 1 },
  ]);
});

test('changes describe what differs and never store secrets', () => {
  assert.deepEqual(permissionChanges(Permission.SPEAK, Permission.SPEAK | Permission.KICK_MEMBERS), [
    { field: 'permissionsGranted', after: ['KICK_MEMBERS'] },
  ]);
  assert.deepEqual(permissionChanges(Permission.SPEAK | Permission.MUTE_MEMBERS, 0), [
    { field: 'permissionsRevoked', after: ['SPEAK', 'MUTE_MEMBERS'] },
  ]);
  const server: ServerRecord = { id: 's', name: 'Old', passwordHash: 'hash-1', createdAt: 1, maxUsers: 10, iconPath: 'a.png' };
  const changes = serverSettingsChanges(server, { ...server, name: 'New', passwordHash: 'hash-2', iconPath: 'b.png', voiceMode: 'sfu' });
  assert.deepEqual(changes, [
    { field: 'name', before: 'Old', after: 'New' },
    { field: 'voiceMode', before: 'p2p', after: 'sfu' },
    { field: 'password' },
    { field: 'icon' },
  ]);
  assert.equal(JSON.stringify(changes).includes('hash'), false);
  assert.deepEqual(serverSettingsChanges(server, { ...server, passwordHash: '' }), [{ field: 'password', before: true, after: false }]);
  assert.deepEqual(serverSettingsChanges(server, { ...server, allowSoundboard: true }), [], 'explicit defaults are not changes');

  const names = { category: (id: string | null | undefined) => id === 'cat' ? 'Games' : null, role: () => 'Mods', user: () => 'Ana' };
  const channel = {
    id: 'c', name: 'general', serverId: 's', type: 'VOICE' as const, position: 0, createdAt: 1, categoryId: null,
    isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true, maxParticipants: 5, permissionOverwrites: [],
  };
  assert.deepEqual(channelChanges(channel, {
    ...channel, name: 'chat', categoryId: 'cat', maxParticipants: 8,
    permissionOverwrites: [{ roleId: 'mods', allow: Permission.SPEAK, deny: 0 }, { userId: 'ana', allow: 0, deny: Permission.SPEAK }],
  }, names), [
    { field: 'name', before: 'general', after: 'chat' },
    { field: 'userLimit', before: 5, after: 8 },
    { field: 'category', before: null, after: 'Games' },
    { field: 'permissions', after: ['Mods', 'Ana'] },
  ]);
  assert.deepEqual(channelChanges(channel, { ...channel }, names), []);
});

test('entries are stored, filtered, searched without accents and paged newest first', async (t) => {
  const { audit } = await service(t);
  audit.record('channel.create', { actor: admin, target: { type: 'channel', id: 'c1', name: 'Geral' } });
  audit.record('voice.move', {
    actor: admin, target: { type: 'user', id: 'u1', name: 'João' },
    related: { from: { type: 'channel', id: 'v1', name: 'Lobby' }, to: { type: 'channel', id: 'v2', name: 'Palco' }, unused: null },
  });
  audit.record('role.assign', { actor: admin, target: { type: 'user', id: 'u2', name: 'Maria' }, related: { role: { type: 'role', id: 'r', name: 'Moderação' } } });
  const page = audit.list({ serverId: 'server-a' });
  assert.equal(serverAuditPageSchema.safeParse(page).success, true);
  assert.deepEqual(page.entries.map(entry => entry.action), ['role.assign', 'voice.move', 'channel.create']);
  assert.equal(page.hasMore, false);
  assert.equal(page.retentionDays, SERVER_AUDIT_LIMITS.RETENTION_DAYS);
  const move = page.entries[1];
  assert.equal(move.related.to?.name, 'Palco');
  assert.equal('unused' in move.related, false);

  assert.deepEqual(audit.list({ serverId: 'server-a', category: 'voice' }).entries.map(entry => entry.action), ['voice.move']);
  assert.deepEqual(audit.list({ serverId: 'server-a', query: 'joao' }).entries.map(entry => entry.action), ['voice.move']);
  assert.deepEqual(audit.list({ serverId: 'server-a', query: 'MODERACAO' }).entries.map(entry => entry.action), ['role.assign']);
  assert.deepEqual(audit.list({ serverId: 'server-a', query: '%' }).entries, [], 'LIKE wildcards are literal');
  assert.deepEqual(audit.list({ serverId: 'server-a', query: 'palco', category: 'roles' }).entries, []);

  const first = audit.list({ serverId: 'server-a', limit: 2 });
  assert.equal(first.hasMore, true);
  const older = audit.list({ serverId: 'server-a', limit: 2, before: first.entries[1].id });
  assert.deepEqual(older.entries.map(entry => entry.action), ['channel.create']);
  assert.equal(older.hasMore, false);
  audit.record('member.kick', { actor: admin, target: { type: 'user', id: 'u3', name: 'Zé' } });
  const newer = audit.list({ serverId: 'server-a', after: first.entries[0].id });
  assert.deepEqual(newer.entries.map(entry => entry.action), ['member.kick']);
});

test('values are clamped so one oversized name cannot drop or break the page', async (t) => {
  const { audit } = await service(t);
  audit.record('server.update', {
    actor: { ...admin, name: 'A'.repeat(500) },
    changes: [
      { field: 'name', before: 'x'.repeat(2000), after: 'y' },
      { field: 'permissionsGranted', after: Array.from({ length: 100 }, (_, index) => `P${index}`) },
      ...Array.from({ length: 50 }, () => ({ field: 'icon' })),
    ],
    detail: 'd'.repeat(5000),
  });
  const [entry] = audit.list({ serverId: 'server-a' }).entries;
  assert.equal(entry.actor?.name.length, SERVER_AUDIT_LIMITS.MAX_NAME_LENGTH);
  assert.equal(entry.changes.length, SERVER_AUDIT_LIMITS.MAX_CHANGES);
  assert.equal(String(entry.changes[0].before).length, SERVER_AUDIT_LIMITS.MAX_VALUE_LENGTH);
  assert.equal((entry.changes[1].after as string[]).length, SERVER_AUDIT_LIMITS.MAX_LIST_ITEMS);
  assert.equal(entry.detail?.length, SERVER_AUDIT_LIMITS.MAX_DETAIL_LENGTH);
});

test('retention hides and prunes old entries, and the count cap keeps the newest', async (t) => {
  let now = 1_000 * DAY;
  const { audit, repository } = await service(t, () => now);
  audit.record('channel.create', { actor: admin, target: { type: 'channel', id: 'old', name: 'Old' } });
  now += (SERVER_AUDIT_LIMITS.RETENTION_DAYS + 1) * DAY;
  audit.record('channel.create', { actor: admin, target: { type: 'channel', id: 'new', name: 'New' } });
  assert.deepEqual(audit.list({ serverId: 'server-a' }).entries.map(entry => entry.target?.id), ['new']);
  assert.deepEqual(repository.list({ createdSince: 0, limit: 10 }).map(entry => entry.target?.id), ['new', 'old']);
  repository.prune(now - SERVER_AUDIT_LIMITS.RETENTION_DAYS * DAY, SERVER_AUDIT_ACTIVITY_ACTIONS, 10, 10);
  assert.deepEqual(repository.list({ createdSince: 0, limit: 10 }).map(entry => entry.target?.id), ['new']);
  for (const id of ['a', 'b', 'c']) audit.record('channel.create', { actor: admin, target: { type: 'channel', id, name: id } });
  repository.prune(0, SERVER_AUDIT_ACTIVITY_ACTIONS, 10, 2);
  assert.deepEqual(repository.list({ createdSince: 0, limit: 10 }).map(entry => entry.target?.id), ['c', 'b']);
  audit.record('channel.create', { actor: admin, target: { type: 'channel', id: 'd', name: 'd' } });
  const ids = repository.list({ createdSince: 0, limit: 10 }).map(entry => entry.id);
  assert.ok(ids[0] > ids[1], 'ids are never reused after pruning');
});

test('members repeating cheap actions can neither flood the log nor push moderation out', async (t) => {
  const { audit, repository } = await service(t);
  audit.record('member.kick', { actor: admin, target: { type: 'user', id: 'victim', name: 'Victim' } });
  const spammer = { type: 'user', id: 'spammer', name: 'Spammer' };
  for (let index = 0; index < SERVER_AUDIT_LIMITS.ACTIVITY_ENTRIES_PER_MINUTE + 20; index++) {
    audit.record('member.nickname', { actor: spammer, changes: [{ field: 'nickname', before: `a${index}`, after: `b${index}` }] });
  }
  const recorded = audit.list({ serverId: 'server-a', category: 'members', limit: 100 }).entries;
  assert.equal(recorded.filter(entry => entry.action === 'member.nickname').length, SERVER_AUDIT_LIMITS.ACTIVITY_ENTRIES_PER_MINUTE,
    'one person only fills a bounded share per minute');
  audit.record('bot.command', { actor: admin, target: { type: 'bot', id: 'bot', name: 'Bot' }, detail: '/play' });
  repository.prune(0, SERVER_AUDIT_ACTIVITY_ACTIONS, 5, 10);
  const left = repository.list({ createdSince: 0, limit: 100 });
  assert.equal(left.filter(entry => SERVER_AUDIT_ACTIVITY_ACTIONS.some(action => action === entry.action)).length, 5);
  assert.ok(left.some(entry => entry.action === 'member.kick'), 'moderation keeps its own quota');
  assert.ok(left.some(entry => entry.action === 'bot.command'), 'the newest activity survives');
});

test('handler authorizes administrators and auditors only, and binds the request to this server', async (t) => {
  const { audit } = await service(t);
  audit.record('channel.create', { actor: admin, target: { type: 'channel', id: 'c', name: 'General' } });
  const permissions = new Map<string, number>();
  const current = new Set<ServerAuditSession>();
  let version = 0;
  const responses: Array<ProtocolMessage<ServerAuditPagePayload | ServerErrorPayload>> = [];
  const handler = new ServerAuditHandler(audit, {
    getRoleAccessVersion: () => version,
    checkPermission: async (userId, permission) => hasPermission(permissions.get(userId) ?? DEFAULT_PERMISSIONS, permission),
  }, { isCurrent: session => current.has(session), send: (_session, message) => responses.push(message) });
  t.after(() => handler.close());
  const session = (id: string, bits: number, isBot = false): ServerAuditSession => {
    const ws: unknown = Reflect.construct(WebSocket, [null, undefined, { autoPong: true, closeTimeout: 0 }]);
    assert.ok(ws instanceof WebSocket);
    const value = { ws, sessionId: `${id}:device`, isBot, user: { id, clientId: id, nickname: id, status: 'ONLINE' as const, joinedAt: 1, isBot } };
    permissions.set(id, bits);
    current.add(value);
    return value;
  };
  let request = 0;
  const call = async (target: ServerAuditSession, payload: unknown = { serverId: 'server-a' }) => {
    const requestId = `audit-${request++}`;
    await handler.handle(target, payload, requestId);
    return responses.find(response => response.requestId === requestId);
  };
  const code = (message: ProtocolMessage<unknown> | undefined) => {
    assert.equal(message?.type, MessageType.SERVER_ERROR);
    return record(message?.payload).code;
  };
  for (const bits of [Permission.ADMINISTRATOR, Permission.VIEW_AUDIT_LOG]) {
    const response = await call(session(`allowed-${bits}`, bits));
    assert.equal(response?.type, MessageType.SERVER_AUDIT_PAGE);
    assert.equal(serverAuditPageSchema.parse(response?.payload).entries.length, 1);
  }
  for (const bits of [DEFAULT_PERMISSIONS, Permission.MANAGE_SERVER | Permission.VIEW_SERVER_MONITOR, 0]) {
    assert.equal(code(await call(session(`denied-${bits}`, bits))), ProtocolErrorCode.PERMISSION_DENIED);
  }
  assert.equal(code(await call(session('admin-bot', Permission.ADMINISTRATOR, true))), ProtocolErrorCode.PERMISSION_DENIED);
  const auditor = session('auditor', Permission.VIEW_AUDIT_LOG);
  assert.equal(code(await call(auditor, { serverId: 'server-b' })), ProtocolErrorCode.PERMISSION_DENIED);
  for (const payload of [{}, { serverId: 'server-a', before: 1, after: 2 }, { serverId: 'server-a', userId: 'x' }]) {
    assert.equal(code(await call(auditor, payload)), ProtocolErrorCode.BAD_REQUEST);
  }
  version = 1;
  const racing = session('racing', Permission.VIEW_AUDIT_LOG);
  const raced = handler.handle(racing, { serverId: 'server-a' }, 'race');
  version = 2;
  await raced;
  assert.equal(code(responses.find(response => response.requestId === 'race')), ProtocolErrorCode.PERMISSION_DENIED,
    'a role change during the permission check cannot publish the page');
  const gone = session('gone', Permission.VIEW_AUDIT_LOG);
  current.delete(gone);
  assert.equal(await call(gone), undefined, 'a replaced session receives nothing');
});

class AuditPeer {
  private readonly listeners = new Set<(message: ProtocolMessage<unknown>) => void>();

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const parsed = record(JSON.parse(data.toString()));
      const type = Object.values(MessageType).find(value => value === parsed.type);
      assert.ok(type);
      const message = { type, requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined, payload: parsed.payload };
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
}

async function realServer(t: TestContext) {
  const dataDir = path.join(__dirname, '..', `.audit-test-${process.pid}-${randomUUID()}`);
  const sockets: WebSocket[] = [];
  const server = await MonkyServer.create({ dataDir, port: 0, discoveryPort: 0, serverName: 'Audited', maxUsers: 20, voiceMode: 'p2p' });
  t.after(async () => {
    try {
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.CLOSED) continue;
        const closed = once(ws, 'close');
        ws.terminate();
        await closed;
      }
      await server.stop();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await server.start();
  const port = (await server.getStats()).port;
  const human = async (nickname: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    const peer = new AuditPeer(ws);
    await once(ws, 'open');
    const pair = generateKeyPairSync('ed25519');
    const challenge = await peer.request(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION, nickname, deviceId: randomUUID(),
      publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
    });
    const signature = sign(null, Buffer.from(text(record(challenge.payload).nonce), 'hex'), pair.privateKey).toString('hex');
    const auth = await peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, { signature });
    assert.equal(auth.type, MessageType.AUTH_SUCCESS);
    const payload = record(auth.payload);
    const details = record(payload.server);
    return { peer, id: text(record(payload.currentUser).id), serverId: text(details.id), details };
  };
  return { human };
}

test('real server: channel moves, categories, nicknames, moderation and community events are recorded', { timeout: 60_000 }, async (t) => {
  t.mock.method(LanBroadcaster.prototype, 'start', async () => {});
  const f = await realServer(t);
  const owner = await f.human('Owner');
  const member = await f.human('Member');
  const entries = async (payload: Record<string, unknown> = {}): Promise<ServerAuditEntry[]> => {
    const response = await owner.peer.request(MessageType.SERVER_AUDIT_GET, { serverId: owner.serverId, ...payload });
    assert.equal(response.type, MessageType.SERVER_AUDIT_PAGE);
    return serverAuditPageSchema.parse(response.payload).entries;
  };
  const textChannel = records(owner.details.channels).find(channel => channel.type === 'TEXT');
  assert.ok(textChannel);
  const textChannelId = text(textChannel.id);

  const first = text(record(record((await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'first', type: 'TEXT' })).payload).channel).id);
  const second = text(record(record((await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'second', type: 'TEXT' })).payload).channel).id);
  const root = (await entries({ category: 'channels' })).length;
  assert.ok(root >= 2);
  const state = await owner.peer.request(MessageType.CATEGORY_CREATE, { name: 'Games' });
  assert.equal(state.type, MessageType.CATEGORIES_UPDATED);
  const category = records(record(state.payload).categories).find(entry => entry.name === 'Games');
  assert.ok(category);
  const categoryId = text(category.id);
  await owner.peer.request(MessageType.CATEGORY_UPDATE, { categoryId, name: 'Jogos' });
  await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: first, categoryId });
  await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: second, categoryId });
  const reordered = await owner.peer.request(MessageType.CHANNEL_REORDER, { categoryId, orderedIds: [second, first] });
  assert.equal(reordered.type, MessageType.CHANNELS_REORDERED);
  await owner.peer.request(MessageType.CHANNEL_DELETE, { channelId: second });
  await owner.peer.request(MessageType.CATEGORY_DELETE, { categoryId });

  const tree = await entries({ category: 'channels' });
  const moved = tree.find(entry => entry.action === 'channel.move');
  assert.equal(moved?.target?.name, 'second', 'only the dragged channel is recorded');
  assert.equal(moved?.related.category?.name, 'Jogos');
  assert.deepEqual(moved?.changes, [{ field: 'position', before: 2, after: 1 }]);
  assert.equal(tree.filter(entry => entry.action === 'channel.move').length, 1);
  assert.deepEqual(tree.find(entry => entry.action === 'category.update')?.changes, [{ field: 'name', before: 'Games', after: 'Jogos' }]);
  assert.deepEqual(tree.find(entry => entry.action === 'channel.update' && entry.target?.id === first)?.changes,
    [{ field: 'category', before: null, after: 'Jogos' }]);
  assert.equal(tree.find(entry => entry.action === 'channel.delete')?.target?.name, 'second');
  assert.equal(tree.find(entry => entry.action === 'category.delete')?.target?.name, 'Jogos');
  assert.equal(tree.find(entry => entry.action === 'category.create')?.target?.name, 'Games');

  const renamed = await member.peer.request(MessageType.USER_CHANGE_NICKNAME, { newNickname: 'Member Renamed' });
  assert.equal(renamed.type, MessageType.USER_UPDATED);
  const nickname = (await entries({ category: 'members' })).find(entry => entry.action === 'member.nickname');
  assert.equal(nickname?.actor?.name, 'Member');
  assert.deepEqual(nickname?.changes, [{ field: 'nickname', before: 'Member', after: 'Member Renamed' }]);

  const sent = await member.peer.request(MessageType.CHAT_SEND, { channelId: textChannelId, content: 'please remove me' });
  assert.equal(sent.type, MessageType.CHAT_MESSAGE);
  const messageId = text(record(sent.payload).id);
  const own = await owner.peer.request(MessageType.CHAT_SEND, { channelId: textChannelId, content: 'mine' });
  await owner.peer.request(MessageType.CHAT_DELETE, { channelId: textChannelId, messageId: text(record(own.payload).id) });
  await owner.peer.request(MessageType.CHAT_DELETE, { channelId: textChannelId, messageId });
  const deletions = (await entries({ category: 'messages' })).filter(entry => entry.action === 'message.delete');
  assert.equal(deletions.length, 1, 'deleting your own message is not moderation');
  assert.equal(deletions[0].target?.name, 'Member Renamed');
  assert.equal(deletions[0].related.channel?.id, textChannelId);
  assert.equal(JSON.stringify(deletions).includes('please remove me'), false, 'message content is never copied');

  assert.equal((await owner.peer.request(MessageType.COMMUNITY_UPDATE_SETTINGS, { eventsEnabled: true })).type, MessageType.COMMUNITY_ACK);
  const startsAt = Date.now() + DAY;
  const saved = await owner.peer.request(MessageType.EVENT_SAVE, {
    title: 'Game night', description: '', location: { kind: 'external', label: 'Online' },
    startsAt, endsAt: startsAt + 3_600_000, repeat: 'none', timeZone: 'UTC',
  });
  assert.equal(saved.type, MessageType.EVENT_SAVED);
  const event = record(record(saved.payload).event);
  const cancelled = await owner.peer.request(MessageType.EVENT_CONTROL, { id: text(event.id), expectedRevision: event.revision, action: 'cancel' });
  assert.equal(cancelled.type, MessageType.COMMUNITY_ACK);
  const community = await entries({ category: 'community' });
  assert.deepEqual(community.map(entry => entry.action), ['event.cancel', 'event.create', 'community.update']);
  assert.equal(community[0].target?.name, 'Game night');
  assert.deepEqual(community[1].changes, [
    { field: 'startsAt', after: startsAt }, { field: 'endsAt', after: startsAt + 3_600_000 }, { field: 'location', after: 'Online' },
  ]);
  assert.deepEqual(community[2].changes, [{ field: 'eventsEnabled', before: false, after: true }]);
});

test('real server: administrative actions are recorded with names and only auditors can read them', { timeout: 60_000 }, async (t) => {
  t.mock.method(LanBroadcaster.prototype, 'start', async () => {});
  const f = await realServer(t);
  const owner = await f.human('Owner');
  const auditor = await f.human('Auditor');
  const manager = await f.human('Manager');
  const member = await f.human('Member');
  const visitor = await f.human('Visitor');
  const read = async (peer: AuditPeer, payload: Record<string, unknown> = {}) =>
    peer.request(MessageType.SERVER_AUDIT_GET, { serverId: owner.serverId, ...payload });
  const entries = async (payload: Record<string, unknown> = {}): Promise<ServerAuditEntry[]> => {
    const response = await read(owner.peer, payload);
    assert.equal(response.type, MessageType.SERVER_AUDIT_PAGE);
    return serverAuditPageSchema.parse(response.payload).entries;
  };
  assert.deepEqual((await entries({ category: 'members' })).map(entry => entry.target?.name).sort(),
    ['Auditor', 'Manager', 'Member', 'Owner', 'Visitor'], 'every first connection is a join');

  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'lobby', type: 'VOICE' });
  assert.equal(created.type, MessageType.CHANNEL_CREATED);
  const channelId = text(record(record(created.payload).channel).id);
  await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId, name: 'stage', maxParticipants: 12 });
  await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId, name: 'stage' });
  const roles = await owner.peer.request(MessageType.ROLE_CREATE, { name: 'Auditors', permissions: Permission.VIEW_AUDIT_LOG });
  const role = records(record(roles.payload).roles).find(entry => entry.name === 'Auditors');
  assert.ok(role);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: auditor.id, roleId: text(role.id) });
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: auditor.id, roleId: text(role.id) });
  const managers = await owner.peer.request(MessageType.ROLE_CREATE, { name: 'Managers', permissions: Permission.MANAGE_SERVER });
  const managerRole = records(record(managers.payload).roles).find(entry => entry.name === 'Managers');
  assert.ok(managerRole);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: manager.id, roleId: text(managerRole.id) });
  await owner.peer.request(MessageType.ADMIN_MUTE_USER, { targetUserId: member.id, muted: true });
  await owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { name: 'Audited server', password: 'top-secret-phrase' });
  const kicked = await owner.peer.request(MessageType.MEMBER_KICK, { targetUserId: member.id });
  assert.equal(kicked.type, MessageType.MEMBER_KICKED);

  const all = await entries();
  const actions = all.map(entry => entry.action);
  for (const action of ['channel.create', 'channel.update', 'role.create', 'role.assign', 'voice.mute', 'server.update', 'member.kick']) {
    assert.ok(actions.includes(action), `${action} is recorded`);
  }
  assert.equal(actions.filter(action => action === 'channel.update').length, 1, 'saving without changes records nothing');
  assert.equal(all.filter(entry => entry.action === 'role.assign' && entry.target?.id === auditor.id).length, 1,
    'assigning a role already held records nothing');
  const update = all.find(entry => entry.action === 'channel.update');
  assert.equal(update?.actor?.name, 'Owner');
  assert.equal(update?.target?.name, 'stage');
  assert.deepEqual(update?.changes, [
    { field: 'name', before: 'lobby', after: 'stage' },
    { field: 'userLimit', before: 10, after: 12 },
  ]);
  const assigned = all.find(entry => entry.action === 'role.assign' && entry.target?.id === auditor.id);
  assert.equal(assigned?.related.role?.name, 'Auditors');
  assert.equal(all.find(entry => entry.action === 'member.kick')?.target?.name, 'Member');
  assert.equal(all.find(entry => entry.action === 'voice.mute')?.target?.name, 'Member');
  const settings = all.find(entry => entry.action === 'server.update');
  assert.deepEqual(settings?.changes, [
    { field: 'name', before: 'Audited', after: 'Audited server' },
    { field: 'password', before: false, after: true },
  ]);
  assert.equal(JSON.stringify(all).includes('top-secret-phrase'), false, 'passwords never reach the audit log');
  assert.deepEqual((await entries({ category: 'roles', query: 'auditor' })).map(entry => entry.action).sort(),
    ['role.assign', 'role.create']);

  const auditorPage = await read(auditor.peer);
  assert.equal(auditorPage.type, MessageType.SERVER_AUDIT_PAGE, 'the granted permission opens the audit log');
  for (const denied of [manager.peer, visitor.peer]) {
    const response = await read(denied);
    assert.equal(response.type, MessageType.SERVER_ERROR);
    assert.equal(record(response.payload).code, ProtocolErrorCode.PERMISSION_DENIED);
  }
  await owner.peer.request(MessageType.ROLE_UPDATE, { roleId: text(role.id), permissions: 0 });
  const revoked = await read(auditor.peer);
  assert.equal(record(revoked.payload).code, ProtocolErrorCode.PERMISSION_DENIED, 'revoking the role revokes the audit log');
  const roleUpdate = (await entries({ category: 'roles' })).find(entry => entry.action === 'role.update');
  assert.deepEqual(roleUpdate?.changes, [{ field: 'permissionsRevoked', after: ['VIEW_AUDIT_LOG'] }]);
});
