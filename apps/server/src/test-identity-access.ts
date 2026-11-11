import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  MessageType, Permission, PROTOCOL_VERSION, ProtocolErrorCode, authChallengeSchema, createProtocolOffer,
  identityBanSchema, type ProtocolOffer,
} from '@monky/shared';
import { activeIdentityBan, identityBanNotice } from './domain/identityAccess';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqliteIdentityAccessRepository } from './infrastructure/database/SqliteIdentityAccessRepository';
import { SqlJsDriver } from './infrastructure/database/SqliteWrapper';
import { challengeBytes, createFixture, identity, record, records, text } from './testFixtures/bots';

type Fixture = Awaited<ReturnType<typeof createFixture>>;
const offer = createProtocolOffer('client');
async function login(f: Fixture, nickname: string, keys = identity(), deviceId: string = randomUUID(), guest = false, protocolOffer: ProtocolOffer = offer) {
  const peer = await f.connect();
  const challenge = await peer.request(MessageType.AUTH_CONNECT, {
    protocolVersion: PROTOCOL_VERSION, protocolOffer, nickname, publicKey: keys.publicKey, deviceId, guest,
  });
  if (challenge.type !== MessageType.AUTH_CHALLENGE) return { peer, keys, reply: challenge, id: '' };
  authChallengeSchema.parse(challenge.payload);
  const reply = await peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, {
    signature: sign(null, challengeBytes(challenge.payload), keys.privateKey).toString('hex'),
  });
  const id = reply.type === MessageType.AUTH_SUCCESS ? text(record(reply.payload.currentUser).id) : '';
  return { peer, keys, reply, id };
}

test('a guest must prove its temporary key, cannot claim an unowned server or downgrade a permanent member', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const noOwner = await login(f, 'Guest', identity(), randomUUID(), true);
  assert.equal(noOwner.reply.payload.code, ProtocolErrorCode.GUEST_OWNER_REQUIRED);
  assert.equal(await f.userRepo.count(), 0);
  const owner = await f.human('Owner');
  const noFeature = await login(f, 'Guest', identity(), randomUUID(), true, { ...offer, features: offer.features.filter(x => x !== 'guest-membership') });
  assert.equal(noFeature.reply.payload.code, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
  const downgrade = await login(f, 'Owner', owner.keys, randomUUID(), true);
  assert.equal(downgrade.reply.payload.code, ProtocolErrorCode.BAD_REQUEST);
  assert.equal((await f.serverRepo.getServer())?.ownerUserId, owner.id);
  const peer = await f.connect();
  const challenge = await peer.request(MessageType.AUTH_CONNECT, {
    protocolVersion: PROTOCOL_VERSION, protocolOffer: offer, nickname: 'Invalid Guest', publicKey: identity().publicKey, guest: true,
  });
  assert.equal(challenge.type, MessageType.AUTH_CHALLENGE);
  assert.ok(record(challenge.payload.protocol).features instanceof Array);
  const failed = await peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, { signature: '00'.repeat(64) });
  assert.equal(failed.type, MessageType.AUTH_FAILED);
  assert.equal(await f.userRepo.count(), 1);
});

test('guest membership ends with its last device, preserves authored history and revokes old grants', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const owner = await f.human('Owner');
  const guest = await login(f, 'Guest', identity(), 'device-a', true);
  assert.equal(guest.reply.type, MessageType.AUTH_SUCCESS);
  assert.equal(record(guest.reply.payload.currentUser).guest, true);
  const second = await login(f, 'Guest', guest.keys, 'device-b', true);
  assert.equal(second.id, guest.id);
  const channelId = text(records(record(guest.reply.payload.server).channels).find(c => c.type === 'TEXT')?.id);
  const sent = await guest.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Guest history stays.' });
  assert.equal(sent.type, MessageType.CHAT_MESSAGE);
  const messageId = text(sent.payload.id);
  const token = f.attachmentService.issueUploadToken(guest.id, channelId)!;
  const role = (await f.roleRepo.listAll())[0];
  await f.roleRepo.assignRole(guest.id, role.id);
  await guest.peer.close();
  await owner.peer.barrier();
  assert.ok(await f.userRepo.findById(guest.id), 'another live device keeps the guest a member');
  const since = owner.peer.messages.length;
  await second.peer.close();
  await owner.peer.wait(m => m.type === MessageType.MEMBER_KICKED && m.payload.userId === guest.id, since);
  assert.equal(await f.userRepo.findById(guest.id), null);
  assert.equal(await f.userRepo.count(), 1);
  assert.equal(await f.roleRepo.listRolesForUser(guest.id).then(r => r.length), 0);
  assert.equal(f.attachmentService.consumeUploadToken(token.token), null);
  assert.equal((await f.messageRepo.findById(messageId))?.content, 'Guest history stays.');
  assert.equal((await f.userService.nicknames([guest.id])).get(guest.id), 'Guest');
  assert.equal(f.authService.identityAccess!.retireGuest(guest.id), false, 'teardown is idempotent');
  const reconnected = await login(f, 'Guest Again', guest.keys, 'device-a', false);
  assert.equal(reconnected.reply.type, MessageType.AUTH_SUCCESS);
  assert.equal(reconnected.id, guest.id);
  assert.equal(record(reconnected.reply.payload.currentUser).guest, true, 'omitting the guest flag cannot create a durable membership');
  assert.ok(await f.userRepo.findById(guest.id));
  f.authService.identityAccess!.retireAllGuests();
  assert.equal(await f.userRepo.findById(guest.id), null, 'restart archives orphaned guest memberships');
  assert.ok(await f.messageRepo.findById(messageId));
});

test('personal session discovery includes invisible devices but no other identity and disconnect permits later reconnection', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const owner = await f.human('Owner', identity(), 'a', false, PROTOCOL_VERSION, offer);
  const second = await f.human('Owner', owner.keys, 'b', true, PROTOCOL_VERSION, offer);
  const stranger = await f.human('Stranger', identity(), 'foreign', false, PROTOCOL_VERSION, offer);
  const list = records((await owner.peer.request(MessageType.IDENTITY_SESSIONS_GET)).payload.sessions);
  assert.deepEqual(list.map(s => s.deviceId).sort(), ['a', 'b']);
  assert.equal(list.find(s => s.deviceId === 'a')?.current, true);
  assert.ok(list.every(s => typeof s.connectedAt === 'number'));
  await owner.peer.error(MessageType.IDENTITY_SESSION_DISCONNECT, { sessionId: `${stranger.id}:foreign` }, ProtocolErrorCode.BAD_REQUEST);
  const closed = once(second.peer.ws, 'close');
  const notice = second.peer.wait(m => m.type === MessageType.IDENTITY_SESSION_DISCONNECTED);
  const reply = await owner.peer.request(MessageType.IDENTITY_SESSION_DISCONNECT, { sessionId: `${owner.id}:b` });
  assert.equal(reply.type, MessageType.IDENTITY_SESSION_DISCONNECTED);
  assert.equal((await notice).requestId, undefined);
  await closed;
  assert.equal(records((await owner.peer.request(MessageType.IDENTITY_SESSIONS_GET)).payload.sessions).length, 1);
  const reconnect = await login(f, 'Owner', owner.keys, 'b');
  assert.equal(reconnect.reply.type, MessageType.AUTH_SUCCESS);
  const selfClosed = once(reconnect.peer.ws, 'close');
  const selfNotice = reconnect.peer.wait(m => m.type === MessageType.IDENTITY_SESSION_DISCONNECTED && !m.requestId);
  await reconnect.peer.request(MessageType.IDENTITY_SESSION_DISCONNECT, { sessionId: `${owner.id}:b` });
  await selfNotice;
  await selfClosed;
});

test('identity bans revoke every device, hide private reasons and refuse authentication before any server data', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const owner = await f.human('Owner', identity(), 'owner', false, PROTOCOL_VERSION, offer);
  const target = await f.human('Target', identity(), 'one', false, PROTOCOL_VERSION, offer);
  const second = await f.human('Target', target.keys, 'two', false, PROTOCOL_VERSION, offer);
  const stranger = await f.human('Stranger', identity(), 'third', false, PROTOCOL_VERSION, offer);
  const input = { targetUserId: target.id, reason: 'Private moderation reason', showReason: false, durationSeconds: null };
  await stranger.peer.error(MessageType.IDENTITY_BAN, input, ProtocolErrorCode.PERMISSION_DENIED);
  await owner.peer.error(MessageType.IDENTITY_BAN, { ...input, targetUserId: owner.id }, ProtocolErrorCode.BAD_REQUEST);
  await owner.peer.error(MessageType.IDENTITY_BAN, { ...input, reason: '   ' }, ProtocolErrorCode.BAD_REQUEST);
  const oneClosed = once(target.peer.ws, 'close'), twoClosed = once(second.peer.ws, 'close');
  const oneNotice = target.peer.wait(m => m.type === MessageType.IDENTITY_BANNED);
  const twoNotice = second.peer.wait(m => m.type === MessageType.IDENTITY_BANNED);
  const bans = await owner.peer.request(MessageType.IDENTITY_BAN, input);
  assert.equal(records(bans.payload.bans)[0].reason, input.reason);
  assert.deepEqual((await oneNotice).payload, { expiresAt: null });
  assert.deepEqual((await twoNotice).payload, { expiresAt: null });
  await Promise.all([oneClosed, twoClosed]);
  assert.equal(await f.userRepo.findById(target.id), null, 'a banned member no longer appears as an authorized active member');
  const denied = await login(f, 'Target', target.keys, 'new');
  assert.equal(denied.reply.type, MessageType.AUTH_FAILED);
  assert.equal(denied.reply.payload.code, ProtocolErrorCode.IDENTITY_BANNED);
  assert.deepEqual(denied.reply.payload.ban, { expiresAt: null });
  assert.ok(!denied.peer.messages.some(m => m.type === MessageType.AUTH_SUCCESS));
  assert.ok(!stranger.peer.messages.some(m => JSON.stringify(m).includes(input.reason)));
  await stranger.peer.error(MessageType.IDENTITY_BANS_GET, {}, ProtocolErrorCode.PERMISSION_DENIED);
  f.database.getDb().flush();
  const saved = path.join(f.dataDir, 'bans-copy.db');
  fs.copyFileSync(path.join(f.dataDir, 'server.db'), saved);
  const reopened = await DatabaseConnection.create(saved);
  t.after(() => reopened.close({ discardChanges: true }));
  assert.equal(new SqliteIdentityAccessRepository(reopened.getDb()).ban(target.keys.publicKey)?.reason, input.reason);
  await owner.peer.request(MessageType.IDENTITY_UNBAN, { publicKey: target.keys.publicKey });
  assert.equal((await login(f, 'Target', target.keys, 'new')).reply.type, MessageType.AUTH_SUCCESS);
});

test('custom ban expiry uses an exact threshold and only explicitly public reasons reach the banned identity', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  await f.human('Owner');
  const target = await f.human('Target');
  const repository = f.authService.identityAccess!;
  const ban = { publicKey: target.keys.publicKey, nickname: 'Target', reason: 'Visible reason',
    showReason: true, createdAt: 100, expiresAt: 160 };
  repository.saveBan(ban);
  assert.deepEqual(identityBanNotice(ban), { expiresAt: 160, reason: 'Visible reason' });
  assert.ok(activeIdentityBan(repository, target.keys.publicKey, 159));
  assert.equal(activeIdentityBan(repository, target.keys.publicKey, 160), undefined);
  assert.ok(!identityBanSchema.safeParse({ targetUserId: target.id, reason: 'Valid', showReason: false, durationSeconds: 0 }).success);
  assert.ok(!identityBanSchema.safeParse({ targetUserId: target.id, reason: 'Valid', showReason: false, durationSeconds: 1.1 }).success);
  assert.equal((await login(f, 'Target', target.keys, 'after-expiry')).reply.type, MessageType.AUTH_SUCCESS);
});

test('moderation history retains private reasons and moderator snapshots after unban and restart, with legacy peers gated', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const owner = await f.human('Owner', identity(), 'owner', false, PROTOCOL_VERSION, offer);
  const target = await f.human('Target');
  const stranger = await f.human('Stranger', identity(), 'stranger', false, PROTOCOL_VERSION, offer);
  await owner.peer.request(MessageType.IDENTITY_BAN, {
    targetUserId: target.id, reason: 'Retained private reason', showReason: false, durationSeconds: null,
  });
  const query = { scope: 'all' };
  const page = await owner.peer.request(MessageType.IDENTITY_BAN_HISTORY_GET, query);
  assert.equal(page.type, MessageType.IDENTITY_BAN_HISTORY);
  const entry = records(page.payload.entries)[0];
  assert.equal(entry.status, 'active');
  assert.deepEqual(entry.createdBy, { id: owner.id, nickname: 'Owner' });
  assert.equal(entry.reason, 'Retained private reason');
  assert.equal(entry.showReason, false);
  await stranger.peer.error(MessageType.IDENTITY_BAN_HISTORY_GET, query, ProtocolErrorCode.PERMISSION_DENIED);
  assert.ok(!stranger.peer.messages.some(message => JSON.stringify(message).includes('Retained private reason')));
  await owner.peer.error(MessageType.IDENTITY_UNBAN, { publicKey: target.keys.publicKey, banId: Number(entry.id) + 1 }, ProtocolErrorCode.BAD_REQUEST);
  assert.ok(activeIdentityBan(f.authService.identityAccess, target.keys.publicKey));
  await owner.peer.request(MessageType.IDENTITY_UNBAN, { publicKey: target.keys.publicKey, banId: entry.id });
  const history = records((await owner.peer.request(MessageType.IDENTITY_BAN_HISTORY_GET, query)).payload.entries)[0];
  assert.equal(history.id, entry.id);
  assert.equal(history.reason, entry.reason);
  assert.equal(history.createdAt, entry.createdAt);
  assert.equal(history.status, 'revoked');
  assert.deepEqual(history.endedBy, { id: owner.id, nickname: 'Owner' });
  assert.ok(typeof history.endedAt === 'number' && history.endedAt >= Number(entry.createdAt));
  assert.deepEqual((await owner.peer.request(MessageType.IDENTITY_BAN_HISTORY_GET, { scope: 'active' })).payload.entries, []);
  assert.equal((await login(f, 'Target', target.keys, 'again')).reply.type, MessageType.AUTH_SUCCESS);
  f.database.getDb().flush();
  const saved = path.join(f.dataDir, 'history-copy.db');
  fs.copyFileSync(path.join(f.dataDir, 'server.db'), saved);
  const reopened = await DatabaseConnection.create(saved);
  t.after(() => reopened.close({ discardChanges: true }));
  assert.deepEqual(new SqliteIdentityAccessRepository(reopened.getDb()).history({ scope: 'all' }).entries[0], history);
  const legacy = await login(f, 'Owner', owner.keys, 'legacy-history', false,
    { ...offer, features: offer.features.filter(feature => feature !== 'identity-ban-history') });
  assert.equal(legacy.reply.type, MessageType.AUTH_SUCCESS);
  await legacy.peer.error(MessageType.IDENTITY_BAN_HISTORY_GET, query, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
  assert.equal((await legacy.peer.request(MessageType.IDENTITY_BANS_GET)).type, MessageType.IDENTITY_BANS);
});

test('history pages use stable ids, expiry thresholds and atomic writes without undoing a newer ban', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const repository = f.authService.identityAccess!;
  const moderator = { id: 'moderator', nickname: 'Original moderator' };
  const ban = { publicKey: 'same-key', nickname: 'Target', reason: 'First reason', showReason: false,
    createdAt: 100, expiresAt: 200 };
  repository.saveBan(ban, moderator);
  const first = repository.ban(ban.publicKey)!;
  assert.equal(repository.history({ scope: 'all' }, 199).entries[0].status, 'active');
  assert.equal(repository.history({ scope: 'all' }, 200).entries[0].status, 'expired');
  assert.equal(repository.history({ scope: 'active' }, 200).entries.length, 0);
  assert.equal(repository.unban(ban.publicKey, moderator, first.historyId, 200), false, 'an expired snapshot cannot be revoked');
  repository.saveBan({ ...ban, reason: 'New reason', expiresAt: null }, moderator);
  const second = repository.ban(ban.publicKey)!;
  assert.notEqual(first.historyId, second.historyId, 'equal timestamps never identify different bans');
  assert.equal(repository.unban(ban.publicKey, moderator, first.historyId, 150), false);
  assert.equal(repository.ban(ban.publicKey)?.reason, 'New reason');
  assert.equal(repository.history({ scope: 'all' }, 150).entries[1].status, 'replaced');
  const db = f.database.getDb();
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    if (sql.includes('INSERT OR REPLACE INTO identity_bans')) throw new Error('Injected current-ban write failure');
    return prepare(sql);
  };
  try {
    assert.throws(() => repository.saveBan({ ...ban, reason: 'Must roll back' }, moderator), /Injected current-ban/);
  } finally { db.prepare = prepare; }
  assert.equal(repository.ban(ban.publicKey)?.reason, 'New reason');
  assert.equal(repository.history({ scope: 'all' }, 150).entries.length, 2);
  assert.equal(repository.history({ scope: 'all' }, 150).entries[0].status, 'active');
  for (let i = 0; i < 105; i++) repository.saveBan({ ...ban, publicKey: `key-${i}`, expiresAt: null }, moderator);
  const one = repository.history({ scope: 'all' }, 150);
  assert.equal(one.entries.length, 50);
  assert.ok(one.nextCursor);
  repository.saveBan({ ...ban, publicKey: 'arrived-between-pages', expiresAt: null }, moderator);
  const two = repository.history({ scope: 'all', beforeId: one.nextCursor! }, 150);
  const three = repository.history({ scope: 'all', beforeId: two.nextCursor! }, 150);
  assert.equal(two.entries.length, 50);
  assert.equal(three.entries.length, 7);
  assert.equal(three.nextCursor, null);
  assert.equal(new Set([...one.entries, ...two.entries, ...three.entries].map(entry => entry.id)).size, 107);
  assert.ok([...two.entries, ...three.entries].every(entry => entry.publicKey !== 'arrived-between-pages'));
  moderator.nickname = 'Renamed moderator';
  assert.equal(repository.history({ scope: 'all' }, 150).entries[0].createdBy?.nickname, 'Original moderator');
});

test('revoking moderation while unban awaits cannot mutate with stale authority or deliver private ban data', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const owner = await f.human('Owner');
  const manager = await f.human('Moderator', identity(), 'manager', false, PROTOCOL_VERSION, offer);
  const target = await f.human('Target');
  const role = await f.roleService.createRole(owner.id, { name: 'History moderation', color: '#5865f2', permissions: Permission.MANAGE_SERVER });
  assert.ok(role.success && role.role);
  const roleId = role.role.id;
  await f.roleRepo.assignRole(manager.id, roleId);
  await owner.peer.request(MessageType.IDENTITY_BAN, {
    targetUserId: target.id, reason: 'Race-private reason', showReason: false, durationSeconds: null,
  });
  const banId = f.authService.identityAccess!.ban(target.keys.publicKey)!.historyId;
  const checkPermission = f.permissions.checkPermission.bind(f.permissions);
  let checks = 0;
  f.permissions.checkPermission = async (userId, permission) => {
    const allowed = await checkPermission(userId, permission);
    if (userId === manager.id && permission === Permission.MANAGE_SERVER && ++checks === 2) {
      await f.wsServer['epoch'].change(() => f.roleRepo.unassignRole(manager.id, roleId));
    }
    return allowed;
  };
  t.after(() => { f.permissions.checkPermission = checkPermission; });
  await manager.peer.error(MessageType.IDENTITY_UNBAN, { publicKey: target.keys.publicKey, banId }, ProtocolErrorCode.PERMISSION_DENIED);
  assert.ok(activeIdentityBan(f.authService.identityAccess, target.keys.publicKey), 'authority lost during checking must not revoke the ban');
  f.permissions.checkPermission = checkPermission;
  await f.wsServer['epoch'].change(() => f.roleRepo.assignRole(manager.id, roleId));
  const roleAdmin = f.wsServer['roleAdmin'];
  const broadcastState = roleAdmin.broadcastState.bind(roleAdmin);
  roleAdmin.broadcastState = async () => {
    await f.wsServer['epoch'].change(() => f.roleRepo.unassignRole(manager.id, roleId));
    await broadcastState();
  };
  t.after(() => { roleAdmin.broadcastState = broadcastState; });
  const since = manager.peer.messages.length;
  await manager.peer.error(MessageType.IDENTITY_UNBAN, { publicKey: target.keys.publicKey, banId }, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(activeIdentityBan(f.authService.identityAccess, target.keys.publicKey), undefined, 'an authorized mutation already completed');
  assert.ok(!manager.peer.messages.slice(since).some(message => JSON.stringify(message).includes('Race-private reason')),
    'loss of moderation during broadcast must not expose the private acknowledgement list');
  assert.equal(f.authService.identityAccess!.history({ scope: 'all' }).entries[0].status, 'revoked');
});

test('upgrading an existing ban database preserves active and expired records without inventing moderators', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const db = await SqlJsDriver.create(path.join(f.dataDir, 'legacy-history.db'));
  t.after(() => db.close({ discardChanges: true }));
  db.exec(`CREATE TABLE identity_bans (
    public_key TEXT PRIMARY KEY, nickname TEXT NOT NULL, reason TEXT NOT NULL, show_reason INTEGER NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER
  );`);
  const insert = db.prepare('INSERT INTO identity_bans VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('legacy-active', 'Legacy active', 'Preserved private reason', 0, 100, null);
  insert.run('legacy-expired', 'Legacy expired', 'Preserved public reason', 1, 100, 200);
  const migration = fs.readFileSync(path.join(__dirname, 'infrastructure', 'database', 'migrations', '063_identity_ban_history.sql'), 'utf8');
  db.transaction(() => db.exec(migration))();
  const repository = new SqliteIdentityAccessRepository(db);
  assert.equal(repository.ban('legacy-active')?.reason, 'Preserved private reason');
  const history = repository.history({ scope: 'all' }, 200);
  assert.equal(history.entries.length, 2);
  assert.ok(history.entries.every(entry => entry.createdBy === null && entry.endedBy === null));
  assert.equal(history.entries.find(entry => entry.publicKey === 'legacy-active')?.status, 'active');
  assert.equal(history.entries.find(entry => entry.publicKey === 'legacy-expired')?.status, 'expired');
  assert.equal(repository.history({ scope: 'active' }, 200).entries.length, 1);
});

test('a ban arriving while the login snapshot awaits still prevents AUTH_SUCCESS', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const owner = await f.human('Owner', identity(), 'owner', false, PROTOCOL_VERSION, offer);
  const target = await f.human('Target');
  await target.peer.close();
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.userRepo.listAll.bind(f.userRepo);
  let first = true;
  f.userRepo.listAll = async () => { if (first) { first = false; start(); await gate; } return original(); };
  t.after(() => { release(); f.userRepo.listAll = original; });
  const pending = login(f, 'Target', target.keys, 'delayed');
  await started;
  await owner.peer.request(MessageType.IDENTITY_BAN, { targetUserId: target.id, reason: 'During login', showReason: true, durationSeconds: 300 });
  release();
  const rejected = await pending;
  assert.equal(rejected.reply.type, MessageType.AUTH_FAILED);
  assert.equal(rejected.reply.payload.code, ProtocolErrorCode.IDENTITY_BANNED);
  assert.equal(record(rejected.reply.payload.ban).reason, 'During login');
  assert.ok(!rejected.peer.messages.some(m => m.type === MessageType.AUTH_SUCCESS));
});

test('simultaneous guest admissions and same-device replacement retain exactly one member until all devices leave', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const owner = await f.human('Owner');
  const keys = identity();
  const [one, two] = await Promise.all([login(f, 'Guest', keys, 'one', true), login(f, 'Guest', keys, 'two', true)]);
  assert.equal(one.reply.type, MessageType.AUTH_SUCCESS);
  assert.equal(two.reply.type, MessageType.AUTH_SUCCESS);
  assert.equal(one.id, two.id);
  assert.equal(await f.userRepo.count(), 2);
  const oldClosed = once(one.peer.ws, 'close');
  const replaced = await login(f, 'Guest', keys, 'one', true);
  await oldClosed;
  assert.ok(await f.userRepo.findById(one.id));
  await two.peer.close();
  const since = owner.peer.messages.length;
  await replaced.peer.close();
  await owner.peer.wait(m => m.type === MessageType.MEMBER_KICKED && m.payload.userId === one.id, since);
  assert.equal(await f.userRepo.count(), 1);
});

test('a guest kicked by moderation loses membership through the same idempotent connection teardown', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const owner = await f.human('Owner', identity(), 'owner', false, PROTOCOL_VERSION, offer);
  const guest = await login(f, 'Guest', identity(), 'guest', true);
  const channelId = text(records(record(guest.reply.payload.server).channels).find(c => c.type === 'TEXT')?.id);
  const message = await guest.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Guest history survives a kick.' });
  const closed = once(guest.peer.ws, 'close');
  const since = owner.peer.messages.length;
  await owner.peer.request(MessageType.MEMBER_KICK, { targetUserId: guest.id });
  await closed;
  await owner.peer.wait(m => m.type === MessageType.MEMBER_KICKED && m.payload.userId === guest.id, since);
  assert.equal(await f.userRepo.count(), 1);
  assert.equal(await f.userRepo.findById(guest.id), null);
  assert.equal(f.authService.identityAccess!.retireGuest(guest.id), false);
  assert.equal((await f.messageRepo.findById(text(message.payload.id)))?.content, 'Guest history survives a kick.');
  assert.equal((await f.userService.nicknames([guest.id])).get(guest.id), 'Guest');
});

test('a connection cancelled before its guest snapshot completes leaves no member or old roles', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  const owner = await f.human('Owner');
  const keys = identity();
  const peer = await f.connect();
  const challenge = await peer.request(MessageType.AUTH_CONNECT, {
    protocolVersion: PROTOCOL_VERSION, protocolOffer: offer, nickname: 'Guest', publicKey: keys.publicKey, guest: true,
  });
  let started!: () => void, release!: () => void, completed!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { completed = resolve; });
  const original = f.userRepo.listAll.bind(f.userRepo);
  f.userRepo.listAll = async () => { started(); await gate; return original(); };
  const originalAdmission = f.authService.withIdentityAdmission.bind(f.authService);
  f.authService.withIdentityAdmission = async (ws, action) => { try { await originalAdmission(ws, action); } finally { completed(); } };
  t.after(() => { release(); f.userRepo.listAll = original; f.authService.withIdentityAdmission = originalAdmission; });
  peer.send(MessageType.AUTH_CHALLENGE_RESPONSE, { signature: sign(null, challengeBytes(challenge.payload), keys.privateKey).toString('hex') }, 'guest-auth');
  await start;
  await peer.close();
  release();
  await done;
  const archived = await f.userRepo.findByPublicKey(keys.publicKey);
  assert.ok(archived?.guest);
  assert.equal(await f.userRepo.findById(archived.id), null);
  assert.equal(await f.roleRepo.listRolesForUser(archived.id).then(r => r.length), 0);
  assert.equal(await f.userRepo.count(), 1);
  await owner.peer.barrier();
});
