import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LIMITS, MIN_CLIENT_PROTOCOL, MIN_BOT_PROTOCOL, MessageType, ProtocolErrorCode,
  PROTOCOL_VERSION, Permission, createProtocolOffer, negotiateProtocol, messageBlocksContent,
} from '@monky/shared';
import { createFixture, identity, record, records, text } from './testFixtures/bots';
import { SqliteMentionRepository, SqliteMessageRepository } from './infrastructure/database/SqliteRepositories';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';

test('a pending deletion survives closing and reopening the database with its original deadline and code blocks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-delete-undo-'));
  const filename = path.join(root, 'server.db');
  let database = await DatabaseConnection.create(filename);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  database.getDb().exec(`
    INSERT INTO server_meta (id,name,password_hash,created_at) VALUES ('server','Test','',1);
    INSERT INTO users (id,client_id,nickname,created_at,last_seen_at) VALUES ('author','device','Author',1,1);
    INSERT INTO channels (id,server_id,name,type,created_at) VALUES ('chat','server','chat','TEXT',1);
  `);
  const blocks = [{ type: 'code' as const, language: 'javascript', code: 'const original = 1;' }];
  let repository = new SqliteMessageRepository(database.getDb());
  await repository.create({ id: 'message', userId: 'author', channelId: 'chat', isSystem: false,
    createdAt: 1, content: messageBlocksContent(blocks), blocks });
  await repository.markDeleted('message', 1000, 'author', 61000);
  database.close();
  database = await DatabaseConnection.create(filename);
  repository = new SqliteMessageRepository(database.getDb());
  assert.equal((await repository.findById('message'))?.content, '');
  assert.equal((await repository.findById('message'))?.deleteUndoUntil, 61000);
  assert.equal(await repository.restoreDeleted('message', 'author', 1000, 1, 60999), true);
  assert.deepEqual((await repository.findById('message'))?.blocks, blocks);
  await repository.markDeleted('message', 70000, 'author', 130000);
  assert.equal(await repository.restoreDeleted('message', 'author', 70000, 3, 130000), false);
  await repository.purgeExpiredDeletions(130000);
  assert.deepEqual(database.getDb().prepare('SELECT * FROM message_deletion_backups').all(), []);
});

test('timed deletion restores the same message, attachments, reactions and references across reconnects', async t => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Undo owner');
  const other = await f.human('Undo reader');
  const server = record(owner.auth.payload.server);
  const channelId = text(records(server.channels).find(channel => channel.type === 'TEXT')?.id);
  assert.equal(server.messageDeleteUndoSeconds, 60);
  const attachmentId = randomUUID();
  await f.attachmentRepo.create({
    id: attachmentId, messageId: null, channelId, userId: owner.id, kind: 'file', filename: 'undo.txt',
    originalName: 'undo.txt', mimeType: 'text/plain', sizeBytes: 10, width: null, height: null,
    durationMs: null, evicted: false, createdAt: Date.now(),
  });
  const sent = await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: '**Keep**', attachmentIds: [attachmentId] });
  const messageId = text(sent.payload.id);
  await other.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Reply', replyToMessageId: messageId });
  await other.peer.request(MessageType.CHAT_REACTION_ADD, { channelId, messageId, emoji: '👍' });
  const deletion = record((await owner.peer.request(MessageType.CHAT_DELETE, { channelId, messageId })).payload.message);
  assert.equal(deletion.content, '');
  assert.equal(deletion.attachments, undefined);
  assert.equal(Number(deletion.deleteUndoUntil) - Number(deletion.deletedAt), 60000);
  assert.equal((await f.messageRepo.findById(messageId))?.content, '');
  assert.ok(!(await f.attachmentRepo.listOldestActive(100)).some(entry => entry.id === attachmentId),
    'Pending undo attachments are protected from storage eviction');
  const request = { channelId, messageId, deletedAt: deletion.deletedAt, revision: deletion.revision };
  await other.peer.error(MessageType.CHAT_RESTORE, request, ProtocolErrorCode.PERMISSION_DENIED);
  await owner.peer.close();
  const reconnected = await f.human('Undo owner', owner.keys, owner.deviceId);
  const history = await f.chatService.loadHistory(channelId);
  assert.equal(history.find(entry => entry.id === messageId)?.deleteUndoUntil, deletion.deleteUndoUntil);
  const restored = record((await reconnected.peer.request(MessageType.CHAT_RESTORE, request)).payload.message);
  assert.equal(restored.id, messageId);
  assert.equal(restored.createdAt, sent.payload.createdAt);
  assert.equal(restored.content, sent.payload.content);
  assert.deepEqual(restored.attachments, sent.payload.attachments);
  assert.equal(records(restored.reactions).length, 1);
  assert.equal((await f.chatService.loadHistory(channelId)).find(entry => entry.reply)?.reply?.content, '**Keep**');
  const secondDeletion = record((await reconnected.peer.request(MessageType.CHAT_DELETE, { channelId, messageId })).payload.message);
  assert.ok(Number(secondDeletion.revision) > Number(deletion.revision));
  await reconnected.peer.error(MessageType.CHAT_RESTORE, request, ProtocolErrorCode.BAD_REQUEST);
});

test('undo settings validate, affect only new deletions, and the server rejects the exact expiry boundary', async t => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Undo admin');
  const author = await f.human('Undo author');
  const channelId = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'TEXT')?.id);
  for (const value of [0, -1, 1.2, 86401, NaN]) {
    assert.equal((await f.authService.updateServerSettings({ messageDeleteUndoSeconds: value })).success, false);
  }
  await author.peer.error(MessageType.SERVER_UPDATE_SETTINGS, { messageDeleteUndoSeconds: 5 }, ProtocolErrorCode.PERMISSION_DENIED);
  const sent = await author.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Moderated' });
  const messageId = text(sent.payload.id);
  const deletion = record((await owner.peer.request(MessageType.CHAT_DELETE, { channelId, messageId })).payload.message);
  await owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { messageDeleteUndoSeconds: 1 });
  assert.equal((await f.serverRepo.getServer())?.messageDeleteUndoSeconds, 1);
  const repeated = record((await owner.peer.request(MessageType.CHAT_DELETE, { channelId, messageId })).payload.message);
  assert.equal(repeated.deleteUndoUntil, deletion.deleteUndoUntil, 'A repeated delete does not extend or shorten its window');
  const denied = await f.chatService.restoreMessage(owner.id, channelId, messageId, Number(deletion.deletedAt), Number(deletion.revision), false);
  assert.equal(denied.success, false, 'A former moderator cannot restore another author without moderation permission');
  const now = t.mock.method(Date, 'now', () => Number(deletion.deleteUndoUntil));
  const expired = await f.chatService.restoreMessage(owner.id, channelId, messageId, Number(deletion.deletedAt), Number(deletion.revision), true);
  assert.equal(expired.success, false, 'Expiry is enforced at the deadline, not when the cleanup timer runs');
  await f.chatService.expireDeletedMessages();
  assert.deepEqual(f.database.getDb().prepare('SELECT message_id FROM message_deletion_backups').all(), []);
  now.mock.restore();
  const next = await author.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Short window' });
  const nextDeletion = record((await author.peer.request(MessageType.CHAT_DELETE, { channelId, messageId: next.payload.id })).payload.message);
  assert.equal(Number(nextDeletion.deleteUndoUntil) - Number(nextDeletion.deletedAt), 1000);
});

test('delivery retries, concurrent requests and reconnects acknowledge one durable message without duplicate mentions or broadcasts', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Delivery owner');
  const recipient = await f.human('Recipient');
  const channelId = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'TEXT')?.id);
  const clientMessageId = randomUUID();
  const payload = { channelId, clientMessageId, content: '@Recipient delivered once' };
  const replies = await Promise.all(Array.from({ length: 4 }, () => owner.peer.request(MessageType.CHAT_SEND, payload)));
  assert.ok(replies.every(reply => reply.type === MessageType.CHAT_MESSAGE && reply.payload.id === clientMessageId));
  assert.equal((await f.chatService.loadHistory(channelId)).filter(message => message.id === clientMessageId).length, 1);
  await recipient.peer.barrier();
  assert.equal(recipient.peer.messages.filter(message => message.type === MessageType.CHAT_MESSAGE && message.payload.id === clientMessageId).length, 1);
  const mentions = new SqliteMentionRepository(f.database.getDb());
  await mentions.clearForUserChannel(recipient.id, channelId);
  await owner.peer.close();
  const reconnected = await f.human('Delivery owner', owner.keys, owner.deviceId);
  const repeated = await reconnected.peer.request(MessageType.CHAT_SEND, payload);
  assert.equal(repeated.payload.id, clientMessageId);
  assert.equal(repeated.payload.createdAt, replies[0].payload.createdAt);
  assert.deepEqual(await mentions.listChannelIdsForUser(recipient.id), []);
  await recipient.peer.error(MessageType.CHAT_SEND, payload, ProtocolErrorCode.BAD_REQUEST);
  await reconnected.peer.request(MessageType.CHAT_DELETE, { channelId, messageId: clientMessageId });
  const deleted = await reconnected.peer.request(MessageType.CHAT_SEND, payload);
  assert.ok(deleted.payload.deletedAt);
  assert.equal(deleted.payload.content, '');
  assert.equal((await f.messageRepo.findById(clientMessageId))?.content, '');
});

test('attachment delivery is atomic and retries preserve its original links', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Attachment owner');
  const channelId = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'TEXT')?.id);
  const clientMessageId = randomUUID();
  const attachmentId = randomUUID();
  const payload = { channelId, clientMessageId, content: 'With file', attachmentIds: [attachmentId] };
  await owner.peer.error(MessageType.CHAT_SEND, payload, ProtocolErrorCode.BAD_REQUEST);
  assert.equal(await f.messageRepo.findById(clientMessageId), null, 'An unavailable attachment never commits an empty message');
  await f.attachmentRepo.create({
    id: attachmentId, messageId: null, channelId, userId: owner.id, kind: 'file', filename: 'fixture.txt',
    originalName: 'fixture.txt', mimeType: 'text/plain', sizeBytes: 10, width: null, height: null,
    durationMs: null, evicted: false, createdAt: Date.now(),
  });
  const first = await owner.peer.request(MessageType.CHAT_SEND, payload);
  assert.equal(first.type, MessageType.CHAT_MESSAGE);
  const repeated = await owner.peer.request(MessageType.CHAT_SEND, payload);
  assert.deepEqual(repeated.payload.attachments, first.payload.attachments);
  assert.equal((await f.attachmentRepo.findByIds([attachmentId]))[0].messageId, clientMessageId);
  const otherId = randomUUID();
  await owner.peer.error(MessageType.CHAT_SEND, { ...payload, clientMessageId: otherId }, ProtocolErrorCode.BAD_REQUEST);
  assert.equal(await f.messageRepo.findById(otherId), null, 'A file cannot be stolen from a previously committed message');
});

test('negotiation keeps known legacy contracts and refuses security-floor downgrades', () => {
  assert.equal(negotiateProtocol(24, undefined, 'client'), null);
  assert.equal(negotiateProtocol(25, createProtocolOffer('client'), 'client'), null);
  assert.ok(negotiateProtocol(24, undefined, 'bot'));
  assert.equal(negotiateProtocol(MIN_CLIENT_PROTOCOL - 1, createProtocolOffer('client'), 'client'), null);
  assert.equal(negotiateProtocol(MIN_BOT_PROTOCOL - 1, createProtocolOffer('bot'), 'bot'), null);
  assert.equal(negotiateProtocol(PROTOCOL_VERSION + 1, undefined, 'client'), null);
  assert.equal(negotiateProtocol(PROTOCOL_VERSION + 1, { minimumVersion: PROTOCOL_VERSION + 1, features: [] }, 'client'), null);
  assert.deepEqual(negotiateProtocol(PROTOCOL_VERSION + 1, { minimumVersion: 24, features: ['chat-blocks', 'unknown'] }, 'client')?.features, ['chat-blocks']);
});

test('clients without negotiated features and legacy bots never receive unsupported features', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const keys = identity();
  const peer = await f.connect();
  const challenge = await peer.request(MessageType.AUTH_CONNECT, {
    protocolVersion: PROTOCOL_VERSION, protocolOffer: { ...createProtocolOffer('client'), features: [] },
    nickname: 'Basic owner', publicKey: keys.publicKey,
  });
  assert.equal(challenge.type, MessageType.AUTH_CHALLENGE);
  const auth = await peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, {
    signature: sign(null, Buffer.from(text(challenge.payload.nonce), 'hex'), keys.privateKey).toString('hex'),
  });
  assert.equal(auth.type, MessageType.AUTH_SUCCESS);
  const server = record(auth.payload.server);
  assert.deepEqual(record(server.protocol).features, []);
  assert.ok(auth.payload.voiceRestrictions);
  const channelId = text(records(server.channels).find(channel => channel.type === 'TEXT')?.id);
  assert.equal((await peer.request(MessageType.CHAT_SEND, { channelId, content: 'Legacy chat' })).type, MessageType.CHAT_MESSAGE);
  await peer.error(MessageType.CHAT_SEND, { channelId, content: 'blocked', blocks: [{ type: 'text', text: 'blocked' }] }, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
  await peer.error(MessageType.SERVER_UPDATE_SETTINGS, { maxMessageLength: 10 }, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
  const created = await peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(created.payload.bot).id);
  const botPeer = await f.connect();
  const botAuth = await botPeer.request(MessageType.AUTH_CONNECT, {
    protocolVersion: 24, nickname: 'Legacy bot', botToken: text(created.payload.token), publicKey: identity().publicKey,
  });
  assert.equal(botAuth.type, MessageType.AUTH_SUCCESS);
  assert.ok(botAuth.payload.voiceRestrictions);
  assert.equal((await f.botRepo.findById(botId))?.lastProtocolVersion, 24);
  assert.equal((await f.botService.getCompatibility()).incompatibleBots, 0);
  assert.equal((await f.botService.getInfo(botId))?.protocolCompatible, true);
});

test('message length defaults to 16000, persists, controls edits and can be disabled', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Length owner');
  const server = record(owner.auth.payload.server);
  const channelId = text(records(server.channels).find(channel => channel.type === 'TEXT')?.id);
  assert.equal(server.maxMessageLength, 16000);
  const sent = await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'x'.repeat(16000) });
  assert.equal(sent.type, MessageType.CHAT_MESSAGE);
  await owner.peer.error(MessageType.CHAT_SEND, { channelId, content: 'x'.repeat(16001) }, ProtocolErrorCode.MESSAGE_TOO_LONG);
  const result = await owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { maxMessageLength: 20 });
  assert.equal(result.type, MessageType.SERVER_SETTINGS_UPDATED);
  assert.equal(result.payload.maxMessageLength, 20);
  assert.equal((await f.serverRepo.getServer())?.maxMessageLength, 20);
  await owner.peer.error(MessageType.CHAT_EDIT, { channelId, messageId: text(sent.payload.id), content: 'x'.repeat(21) }, ProtocolErrorCode.MESSAGE_TOO_LONG);
  await owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { maxMessageLength: 0 });
  assert.equal((await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'x'.repeat(100_000) })).type, MessageType.CHAT_MESSAGE);
  assert.equal((await f.authService.updateServerSettings({ maxMessageLength: -1 })).success, false);
  assert.equal((await f.authService.updateServerSettings({ maxMessageLength: 1.2 })).success, false);
  assert.equal(LIMITS.WS_MAX_PAYLOAD_BYTES, 8 * 1024 * 1024);
});

test('ordered text, code and multiple references survive history and deletion without snapshot leakage', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Block owner');
  const channelId = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'TEXT')?.id);
  const one = await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'first source' });
  const two = await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'second source' });
  const blocks = [
    { type: 'text' as const, text: 'Before' },
    { type: 'reply' as const, messageId: text(one.payload.id) },
    { type: 'code' as const, language: 'typescript', code: 'const code = "```";\n' },
    { type: 'reply' as const, messageId: text(two.payload.id) },
    { type: 'text' as const, text: 'After' },
  ];
  const sent = await owner.peer.request(MessageType.CHAT_SEND, { channelId, blocks, content: 'untrusted duplicate' });
  assert.equal(sent.type, MessageType.CHAT_MESSAGE);
  assert.equal(sent.payload.content, messageBlocksContent(blocks));
  assert.equal(records(sent.payload.blocks)[2].code, blocks[2].code);
  assert.equal(record(records(sent.payload.blocks)[1].reply).content, 'first source');
  assert.deepEqual((await f.messageRepo.findById(text(sent.payload.id)))?.blocks, blocks);
  await owner.peer.request(MessageType.CHAT_DELETE, { channelId, messageId: one.payload.id });
  const history = await f.chatService.loadHistory(channelId, 100);
  const reply = history.find(message => message.id === sent.payload.id);
  assert.ok(reply?.blocks);
  const reference = reply.blocks[1];
  assert.equal(reference.type, 'reply');
  if (reference.type === 'reply') {
    assert.equal(reference.reply.deleted, true);
    assert.equal(reference.reply.content, '');
    assert.equal(reference.reply.userNickname, '');
  }
  const later = await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: '', blocks: [{ type: 'reply', messageId: one.payload.id }] });
  assert.equal(later.type, MessageType.CHAT_MESSAGE);
  await owner.peer.request(MessageType.CHAT_DELETE, { channelId, messageId: sent.payload.id });
  assert.equal((await f.messageRepo.findById(text(sent.payload.id)))?.blocks, undefined);
});

test('block references cannot forge snapshots or cross channel boundaries', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Reference owner');
  const channelId = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'TEXT')?.id);
  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'private', type: 'TEXT', isPrivate: true });
  const privateId = text(record(created.payload.channel).id);
  const source = await owner.peer.request(MessageType.CHAT_SEND, { channelId: privateId, content: 'secret fixture' });
  await owner.peer.error(MessageType.CHAT_SEND, { channelId, content: '', blocks: [{ type: 'reply', messageId: source.payload.id }] }, ProtocolErrorCode.BAD_REQUEST);
  await owner.peer.error(MessageType.CHAT_SEND, { channelId, content: '', blocks: [{ type: 'reply', messageId: source.payload.id, reply: { content: 'forged' } }] }, ProtocolErrorCode.BAD_REQUEST);
});

test('direct and everyone mentions only persist for readers and never deliver private messages to outsiders', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Owner');
  const allowed = await f.human('Allowed');
  const offline = await f.human('Offline');
  const outsider = await f.human('Outsider');
  const noRead = await f.human('NoRead');
  const role = { id: randomUUID(), name: 'Readers', color: '#123456',
    permissions: Permission.READ_MESSAGES, position: 1, isDefault: false, createdAt: Date.now() };
  await f.roleRepo.create(role);
  await f.roleRepo.assignRole(allowed.id, role.id);
  await f.roleRepo.assignRole(offline.id, role.id);
  const restrictedRole = { ...role, id: randomUUID(), name: 'No read', permissions: Permission.MANAGE_CHANNELS };
  await f.roleRepo.create(restrictedRole);
  for (const assigned of await f.roleRepo.listRolesForUser(noRead.id)) {
    await f.roleRepo.unassignRole(noRead.id, assigned.id);
  }
  await f.roleRepo.assignRole(noRead.id, restrictedRole.id);
  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'mentions-private', type: 'TEXT', isPrivate: true, allowedRoleIds: [role.id],
  });
  const channelId = text(record(created.payload.channel).id);
  const mentions = new SqliteMentionRepository(f.database.getDb());
  await offline.peer.close();
  const recipients = [allowed, offline, outsider, noRead];
  for (const content of ['@Allowed @Offline @Outsider @NoRead', '@everyone', '@todos']) {
    for (const user of recipients) await mentions.clearForUserChannel(user.id, channelId);
    const sent = await owner.peer.request(MessageType.CHAT_SEND, { channelId, content });
    assert.equal(sent.type, MessageType.CHAT_MESSAGE);
    for (const user of recipients) {
      const channels = await mentions.listChannelIdsForUser(user.id);
      assert.equal(channels.includes(channelId), user.id === allowed.id || user.id === offline.id, `${content}: ${user.id}`);
    }
    await outsider.peer.barrier();
    assert.equal(outsider.peer.messages.some(message => message.type === MessageType.CHAT_MESSAGE && message.payload.channelId === channelId), false);
  }
  await f.roleRepo.unassignRole(allowed.id, role.id);
  await mentions.clearForUserChannel(allowed.id, channelId);
  await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: '@Allowed' });
  assert.deepEqual(await mentions.listChannelIdsForUser(allowed.id), []);
});
