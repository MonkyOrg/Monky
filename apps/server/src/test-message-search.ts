import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_PERMISSIONS, MessageType, Permission, ProtocolErrorCode, messageSearchSchema, type UserSummary } from '@monky/shared';
import { MessageSearchService, MessageSearchError } from './application/services/MessageSearchService';
import { SqliteMessageSearchRepository } from './infrastructure/database/SqliteMessageSearchRepository';
import { MessageSearchHandler, type MessageSearchSession } from './infrastructure/websocket/MessageSearchHandler';
import { createFixture, Peer, record, records, text } from './testFixtures/bots';

async function setup(t: test.TestContext) {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Search owner');
  const member = await f.human('Search member');
  const publicChannel = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'TEXT')?.id);
  const created = await f.channelService.createChannel({ name: 'search-private', type: 'TEXT', isPrivate: true, allowedRoleIds: [] });
  assert.ok(created.channel);
  const privateChannel = created.channel.id;
  let version = 0;
  const repo = new SqliteMessageSearchRepository(f.database.getDb());
  const service = new MessageSearchService(repo, f.messageRepo, f.channelService, f.permissions, f.chatService, () => version);
  const insert = async (id: string, content: string, channelId = publicChannel, createdAt = 1000, userId = owner.id) =>
    f.messageRepo.create({ id, content, channelId, userId, createdAt, isSystem: false });
  return { ...f, owner, member, publicChannel, privateChannel, repo, service, insert, bump: () => { version++; } };
}

test('search validates bounded filters and real calendar dates', () => {
  for (const input of [{ query: 'a'.repeat(201) }, { authorIds: Array(51).fill('x') }, { on: '2026-02-30' },
    { before: 5, after: 6 }, { before: Infinity }, { userId: 'forged' }, { contains: ['exe'] }, { sort: 'arbitrary' }]) {
    assert.equal(messageSearchSchema.safeParse(input).success, false);
  }
  assert.deepEqual(messageSearchSchema.parse({ channelIds: ['b', 'a', 'b'] }).channelIds, ['a', 'b']);
});

test('search indexes Unicode text and translations, combines multi-filters, and hydrates the same history message', async t => {
  const f = await setup(t);
  const day = Date.parse('2026-09-20T12:00:00Z');
  await f.insert('matched', 'Olá relatório @Search member https://example.org', f.publicChannel, day);
  await f.insert('unmatched', 'other', f.publicChannel, day);
  await f.insert('hidden', 'Olá relatório @Search member https://secret.invalid', f.privateChannel, day);
  await f.attachmentRepo.create({
    id: 'image-1', messageId: 'matched', channelId: f.publicChannel, userId: f.owner.id, kind: 'image',
    filename: 'image.png', originalName: 'image.png', mimeType: 'image/png', sizeBytes: 10,
    width: 10, height: 10, durationMs: null, evicted: false, createdAt: day,
  });
  const filters = { query: 'ola relat', authorIds: [f.owner.id, 'missing'], channelIds: [f.publicChannel, f.privateChannel],
    mentionsUserIds: [f.member.id], contains: ['image', 'link'], authorType: 'human', on: '2026-09-20',
    before: day + 1, after: day - 1 };
  const result = await f.service.search(f.member.id, filters);
  assert.deepEqual(result.messages.map(message => message.id), ['matched']);
  assert.equal(result.total, 1);
  assert.deepEqual(result.messages[0], (await f.chatService.loadHistory(f.publicChannel, 1, undefined, 'matched'))[0]);
  assert.equal(result.nextCursor, undefined);
  assert.deepEqual((await f.service.search(f.member.id, { ...filters, contains: ['video'] })).messages, []);
  assert.deepEqual((await f.service.search(f.member.id, { ...filters, on: '2026-09-21' })).messages, []);
  assert.deepEqual((await f.service.search(f.member.id, { authorType: 'bot' })).messages, []);
  assert.deepEqual((await f.service.search(f.member.id, { query: '" * - ( )' })).messages, []);
  assert.deepEqual((await f.service.search(f.member.id, { query: 'ola OR nonexistent' })).messages, []);
  assert.deepEqual((await f.service.search(f.member.id, { query: "'); DROP TABLE messages; --" })).messages, []);
  await f.chatService.markMentionsRead(f.member.id, f.publicChannel);
  assert.equal((await f.service.search(f.member.id, { mentionsUserIds: [f.member.id] })).messages.length, 1);
});

test('keyset pages have stable ties and no hidden counts; forged and cross-user cursors are rejected', async t => {
  const f = await setup(t);
  for (let index = 0; index < 61; index++) await f.insert(`page-${String(index).padStart(3, '0')}`, 'page token');
  for (let index = 0; index < 60; index++) await f.insert(`private-${index}`, 'page token', f.privateChannel);
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const result = await f.service.search(f.member.id, { query: 'page', cursor });
    assert.equal(result.total, 61, 'total excludes inaccessible channels on every page');
    ids.push(...result.messages.map(message => message.id));
    if (page === 0) {
      assert.equal(result.messages.length, 25);
      assert.ok(result.nextCursor);
      await assert.rejects(f.service.search(f.owner.id, { query: 'page', cursor: result.nextCursor }), MessageSearchError);
      await assert.rejects(f.service.search(f.member.id, { query: 'different', cursor: result.nextCursor }), MessageSearchError);
      await assert.rejects(f.service.search(f.member.id, { query: 'page', cursor: result.nextCursor + 'x' }), MessageSearchError);
      await assert.rejects(f.service.search(f.member.id, { query: 'page', sort: 'oldest', cursor: result.nextCursor }), MessageSearchError);
    }
    cursor = result.nextCursor;
  }
  assert.equal(ids.length, 61);
  assert.equal(new Set(ids).size, 61);
  assert.equal(cursor, undefined);
  assert.equal(ids[0], 'page-060');
  assert.equal(ids.at(-1), 'page-000');
  const ascending: string[] = [];
  cursor = undefined;
  do {
    const result = await f.service.search(f.member.id, { query: 'page', sort: 'oldest', cursor });
    assert.equal(result.total, 61);
    ascending.push(...result.messages.map(message => message.id));
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(ascending, [...ids].reverse(), 'oldest-first pagination retains stable tie ordering');
});

test('deletion and undo never expose backups; edits and restoration update FTS transactionally', async t => {
  const f = await setup(t);
  await f.insert('secret', 'original secret');
  await f.messageRepo.markDeleted('secret', 2000, f.owner.id, 9000);
  assert.deepEqual((await f.service.search(f.member.id, {})).messages, []);
  assert.deepEqual(f.database.getDb().prepare("SELECT docid FROM message_search_fts WHERE message_search_fts MATCH 'secret'").all(), []);
  assert.ok(f.database.getDb().prepare('SELECT message_id FROM message_deletion_backups WHERE message_id = ?').get('secret'));
  const deleted = await f.messageRepo.findById('secret');
  assert.ok(deleted);
  assert.equal(await f.messageRepo.restoreDeleted('secret', f.owner.id, 2000, deleted.revision ?? 0, 3000), true);
  assert.equal((await f.service.search(f.member.id, { query: 'secret' })).messages.length, 1);
  await f.messageRepo.updateContent('secret', 'replacement only', 4000);
  assert.equal((await f.service.search(f.member.id, { query: 'secret' })).messages.length, 0);
  assert.equal((await f.service.search(f.member.id, { query: 'replacement' })).messages.length, 1);
  await f.channelRepo.delete(f.publicChannel);
  assert.deepEqual((await f.service.search(f.member.id, {})).messages, []);
});

test('each page enforces current READ_MESSAGES, channel access and mid-hydration revocations', async t => {
  const f = await setup(t);
  await f.insert('visible', 'visible');
  let canRead = true;
  let roleVersion: number | null = 0;
  const permissions = {
    checkPermission: async () => canRead,
    getRoleAccessVersion: () => roleVersion,
  };
  const service = new MessageSearchService(f.repo, f.messageRepo, f.channelService, permissions, f.chatService, () => 0);
  assert.equal((await service.search(f.member.id, {})).messages.length, 1);
  canRead = false;
  await f.permissions.updateEveryonePermissions(DEFAULT_PERMISSIONS & ~Permission.READ_MESSAGES);
  assert.deepEqual((await service.search(f.member.id, {})).messages, []);
  await f.permissions.updateEveryonePermissions(DEFAULT_PERMISSIONS);
  canRead = true;
  roleVersion = null;
  await assert.rejects(service.search(f.member.id, {}), MessageSearchError);
  roleVersion = 1;
  const race = new MessageSearchService(f.repo, f.messageRepo, f.channelService, permissions, {
    hydrateMessages: async messages => {
      const result = await f.chatService.hydrateMessages(messages);
      canRead = false;
      roleVersion = 2;
      return result;
    },
  }, () => 0);
  await assert.rejects(race.search(f.member.id, {}), MessageSearchError);
  canRead = true;
  const visibilityRace = new MessageSearchService(f.repo, f.messageRepo, f.channelService, permissions, {
    hydrateMessages: async messages => {
      const result = await f.chatService.hydrateMessages(messages);
      const updated = await f.channelService.updateChannel({
        channelId: f.publicChannel, isPrivate: true, allowedRoleIds: [], inheritCategoryPermissions: false,
      });
      assert.equal(updated.success, true);
      assert.equal(await f.channelService.canUserAccessChannel(f.member.id, f.publicChannel), false);
      return result;
    },
  }, () => 0);
  await assert.rejects(visibilityRace.search(f.member.id, {}), MessageSearchError);
  assert.deepEqual((await service.search(f.member.id, {})).messages, []);
});

test('bot identity is independent of its owner and translated text uses the same hydration', async t => {
  const f = await setup(t);
  const botId = randomUUID();
  await f.botRepo.create({
    id: botId, name: 'Search bot', profilePending: false, tokenHash: randomUUID(),
    avatarPath: null, boundPublicKey: null, createdByUserId: f.owner.id, createdAt: 1,
  });
  await f.messageRepo.createBotMessage({
    id: 'bot-message', channelId: f.publicChannel, userId: botId, content: 'Base response', createdAt: 1000,
    botAuthor: { id: botId, name: 'Search bot', avatarPath: null, ownerUserId: f.owner.id },
    localizations: { en: 'English translation', 'pt-BR': 'Tradução portuguesa' },
  });
  assert.equal((await f.service.search(f.member.id, { authorIds: [f.owner.id] })).messages.length, 0);
  const botResult = await f.service.search(f.member.id, { authorIds: [botId], authorType: 'bot', query: 'traducao' });
  assert.equal(botResult.messages.length, 1);
  assert.equal(botResult.messages[0].isBot, true);
  assert.equal(botResult.messages[0].localizations?.en, 'English translation');
  assert.deepEqual(botResult.messages[0], (await f.chatService.loadHistory(f.publicChannel, 1))[0]);
  assert.equal((await f.service.search(f.member.id, { authorType: 'human' })).messages.length, 0);
});

test('attachment kind, audio MIME, links, multiple channels and exact UTC date boundaries compose', async t => {
  const f = await setup(t);
  const midnight = Date.parse('2026-09-20T00:00:00Z');
  for (const [id, kind, mimeType] of [
    ['picture', 'image', 'image/png'], ['movie', 'video', 'video/mp4'],
    ['sound', 'file', 'audio/ogg'], ['document', 'file', 'application/pdf'],
  ] as const) {
    await f.insert(id, 'attachment', f.publicChannel, midnight);
    await f.attachmentRepo.create({
      id: `attachment-${id}`, messageId: id, channelId: f.publicChannel, userId: f.owner.id, kind,
      filename: id, originalName: id, mimeType, sizeBytes: 10, width: null, height: null,
      durationMs: null, evicted: false, createdAt: midnight,
    });
  }
  await f.insert('link', 'https://example.org', f.publicChannel, midnight + 86400000 - 1);
  await f.insert('next-day', 'boundary', f.publicChannel, midnight + 86400000);
  assert.deepEqual((await f.service.search(f.member.id, { contains: ['video'] })).messages.map(message => message.id), ['movie']);
  assert.deepEqual((await f.service.search(f.member.id, { contains: ['audio'] })).messages.map(message => message.id), ['sound']);
  assert.equal((await f.service.search(f.member.id, { contains: ['file'] })).messages.length, 2);
  assert.equal((await f.service.search(f.member.id, { contains: ['image', 'video'] })).messages.length, 2);
  assert.deepEqual((await f.service.search(f.member.id, { contains: ['link'], on: '2026-09-20' })).messages.map(message => message.id), ['link']);
  assert.equal((await f.service.search(f.member.id, { before: midnight })).messages.length, 0);
  assert.equal((await f.service.search(f.member.id, { after: midnight })).messages.length, 2);
  assert.equal((await f.service.search(f.member.id, { on: '2026-09-20' })).messages.length, 5);
  assert.equal((await f.service.search(f.member.id, { channelIds: [f.privateChannel, 'unknown'] })).messages.length, 0);
  const plan = f.database.getDb().prepare(`EXPLAIN QUERY PLAN SELECT m.id FROM messages m
    WHERE m.rowid IN (SELECT docid FROM message_search_fts WHERE message_search_fts MATCH ?)
    AND m.deleted_at IS NULL AND m.is_system = 0 ORDER BY m.created_at DESC, m.id DESC LIMIT 26`).all('"attach*"');
  assert.match(JSON.stringify(plan), /VIRTUAL TABLE INDEX/i, 'Text search uses FTS, not a wildcard table scan');
});

test('actual role revocation denies the next page even with a previously valid cursor', async t => {
  const f = await setup(t);
  for (let index = 0; index < 26; index++) await f.insert(`role-${index}`, 'role search');
  const first = await f.service.search(f.member.id, {});
  assert.ok(first.nextCursor);
  await f.roleRepo.create({ id: 'search-reader', name: 'Search reader', color: null, position: 1,
    permissions: DEFAULT_PERMISSIONS, isDefault: false, createdAt: 1 });
  await f.roleRepo.assignRole(f.member.id, 'search-reader');
  const roles = await f.roleRepo.listRolesForUser(f.member.id);
  assert.ok(roles.length);
  await f.permissions.withRoleMutation(async () => {
    for (const role of roles) await f.roleRepo.update(role.id, { permissions: 0, deny: Permission.READ_MESSAGES });
  });
  assert.equal(await f.permissions.checkPermission(f.member.id, Permission.READ_MESSAGES), false);
  await assert.rejects(f.service.search(f.member.id, { cursor: first.nextCursor }), MessageSearchError);
});

test('message deletion during hydration discards the entire page and cursor', async t => {
  const f = await setup(t);
  await f.insert('race-delete', 'sensitive');
  const service = new MessageSearchService(f.repo, f.messageRepo, f.channelService, f.permissions, {
    hydrateMessages: async messages => {
      const hydrated = await f.chatService.hydrateMessages(messages);
      await f.messageRepo.markDeleted('race-delete', 2000, f.owner.id, 9000);
      return hydrated;
    },
  }, () => 0);
  await assert.rejects(service.search(f.member.id, {}), MessageSearchError);
});

test('search handler crosses a real WebSocket and denies bot, stale session, and concurrent requests', async t => {
  const f = await setup(t);
  await f.insert('wire', 'wire message');
  const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wsServer, 'listening');
  const sessions = new Set<MessageSearchSession>();
  const handler = new MessageSearchHandler(f.service, {
    isCurrent: session => sessions.has(session),
    send: (session, message) => session.ws.send(JSON.stringify(message)),
  });
  let session: MessageSearchSession | undefined;
  wsServer.on('connection', ws => {
    const user = record(f.member.auth.payload.currentUser);
    const summary: UserSummary = { id: f.member.id, clientId: text(user.clientId), nickname: 'Search member', status: 'ONLINE', joinedAt: 1 };
    session = { ws, user: summary, sessionId: 'search-wire' };
    const bound = session;
    sessions.add(bound);
    ws.on('message', data => {
      const message = record(JSON.parse(data.toString()));
      void handler.handle(bound, message.payload, text(message.requestId));
    });
  });
  const address = wsServer.address();
  assert.ok(address && typeof address !== 'string');
  const peer = new Peer(new WebSocket(`ws://127.0.0.1:${address.port}`));
  await once(peer.ws, 'open');
  t.after(async () => { handler.close(); await peer.close(); await new Promise<void>(resolve => wsServer.close(() => resolve())); });
  const first = await peer.request(MessageType.CHAT_SEARCH, { query: 'wire' });
  assert.equal(first.type, MessageType.CHAT_SEARCH_RESULTS);
  assert.deepEqual(records(first.payload.messages).map(message => message.id), ['wire']);
  await peer.error(MessageType.CHAT_SEARCH, {}, ProtocolErrorCode.RATE_LIMITED);
  assert.ok(session);
  session.isBot = true;
  await peer.error(MessageType.CHAT_SEARCH, {}, ProtocolErrorCode.PERMISSION_DENIED);
  session.isBot = false;
  sessions.delete(session);
  await handler.handle(session, {}, randomUUID());
});
