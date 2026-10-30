import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_PERMISSIONS, MessageType, PUBLIC_AUDIENCE, Permission, type EventSave } from '@monky/shared';
import { AttachmentService } from './application/services/AttachmentService';
import { BotSelectorService } from './application/services/BotSelectorService';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqliteBotSelectorRepository } from './infrastructure/database/SqliteBotSelectorRepository';
import { SqliteCommunityRepository } from './infrastructure/database/SqliteCommunityRepository';
import { SqliteAttachmentRepository, SqliteServerRepository, SqliteUserRepository } from './infrastructure/database/SqliteRepositories';
import { SqlJsDriver, type IDatabaseDriver } from './infrastructure/database/SqliteWrapper';
import { Logger } from './infrastructure/logger/Logger';
import { AttachmentStorageService } from './infrastructure/security/AttachmentStorageService';
import { RateLimiter } from './infrastructure/security/RateLimiter';
import { createApprovedBotFixture, createFixture, record, records, text } from './testFixtures/bots';

function temporaryFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monky-integrity-'));
}

/** Closed, and saved, before its folder goes. */
async function temporaryDatabase(t: test.TestContext): Promise<DatabaseConnection> {
  const folder = temporaryFolder();
  const database = await DatabaseConnection.create(path.join(folder, 'server.db'));
  t.after(() => {
    database.close();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return database;
}

function foreignKeys(db: IDatabaseDriver): number {
  const row: { foreign_keys: number } = db.prepare('PRAGMA foreign_keys').get();
  return row.foreign_keys;
}

function violations(db: IDatabaseDriver): unknown[] {
  return db.prepare('PRAGMA foreign_key_check').all();
}

/** Ids left in `table`, in order. */
function ids(db: IDatabaseDriver, table: string, column = 'id', where = '1 = 1'): string[] {
  const rows: Array<{ value: string }> = db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${where} ORDER BY ${column}`).all();
  return rows.map(row => row.value);
}

function channelOf(auth: { payload: Record<string, unknown> }, type = 'TEXT'): string {
  return text(records(record(auth.payload.server).channels).find(channel => channel.type === type)?.id);
}

test('foreign keys stay enforced after every save, whether sql.js reopens the connection or keeps it (S-APP-1)', async (t) => {
  const database = await temporaryDatabase(t);
  const db = database.getDb();
  assert.ok(db instanceof SqlJsDriver);
  let roles = 0;
  const save = () => {
    db.prepare('INSERT INTO roles (id, name, permissions, created_at) VALUES (?, ?, 0, 0)').run(`role-${roles}`, `Role ${roles++}`);
    db.flush();
  };
  const assertEnforced = () => {
    assert.equal(foreignKeys(db), 1);
    assert.throws(() => db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run('nobody', 'no-role'),
      /FOREIGN KEY constraint failed/);
  };
  // sql.js 1.14 closes and reopens the connection on every export, back to SQLite's defaults.
  save();
  assertEnforced();
  save();
  assertEnforced();

  // Later sql.js versions keep the connection, and so its pragmas, across exports.
  const sqlite = db['db'];
  const reopening = sqlite.export.bind(sqlite);
  t.mock.method(sqlite, 'export', () => {
    const enforced = foreignKeys(db);
    const data = reopening();
    sqlite.exec(`PRAGMA foreign_keys = ${enforced}`);
    return data;
  });
  save();
  assertEnforced();

  // Only the migrations turn them off, and never where SQLite would silently ignore it.
  assert.throws(() => db.transaction(() => db.setForeignKeys(false))(), /inside a transaction/);
  assertEnforced();
  db.setForeignKeys(false);
  save();
  assert.equal(foreignKeys(db), 0);
  db.setForeignKeys(true);
  assertEnforced();

  const rawFolder = temporaryFolder();
  const raw = await SqlJsDriver.create(path.join(rawFolder, 'server.db'));
  try {
    assert.equal(foreignKeys(raw), 1, 'every writable connection enforces them, not only the server one');
  } finally {
    raw.close({ discardChanges: true });
    fs.rmSync(rawFolder, { recursive: true, force: true });
  }
});

test('only a change schedules a save: no-op writes, read-only and rolled-back transactions leave the file alone (S-APP-3)', async (t) => {
  const database = await temporaryDatabase(t);
  const db = database.getDb();
  assert.ok(db instanceof SqlJsDriver);
  db.flush();
  const renames = t.mock.method(fs, 'renameSync');
  const assertClean = (step: string) => {
    assert.equal(db['dirty'], false, step);
    assert.equal(db['saveTimer'], null, step);
  };
  const insertRole = (id: string) =>
    db.prepare('INSERT INTO roles (id, name, permissions, created_at) VALUES (?, ?, 0, 0)').run(id, id);

  assert.equal(db.prepare('DELETE FROM roles WHERE id = ?').run('missing').changes, 0);
  assertClean('a write that matched nothing');
  db.transaction(() => db.prepare('SELECT COUNT(*) AS total FROM roles').get())();
  assertClean('a read-only transaction');
  assert.throws(() => db.transaction(() => {
    insertRole('rolled-back');
    throw new Error('Synthetic failure');
  })(), /Synthetic failure/);
  assertClean('a rolled-back transaction');
  assert.equal(db.prepare('SELECT id FROM roles WHERE id = ?').get('rolled-back'), undefined);
  await db.transactionAsync(async () => db.prepare('SELECT id FROM roles').all());
  assertClean('a read-only asynchronous transaction');
  db.flush();
  assert.equal(renames.mock.callCount(), 0, 'nothing rewrote the file');

  insertRole('kept');
  assert.equal(db['dirty'], true);
  assert.notEqual(db['saveTimer'], null);
  // An asynchronous transaction pauses the pending save; it must not drop it.
  await db.transactionAsync(async () => undefined);
  assert.notEqual(db['saveTimer'], null, 'the earlier change is still on its way to the file');
  db.flush();
  assertClean('after the save');
  assert.equal(renames.mock.callCount(), 1);
  db.transaction(() => db.prepare('UPDATE roles SET name = ? WHERE id = ?').run('Renamed', 'kept'))();
  assert.equal(db['dirty'], true, 'a committed change');
});

test('an idle server opens no transaction and leaves its database file alone (S-APP-3, BOTS-1)', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const db = f.database.getDb();
  assert.ok(db instanceof SqlJsDriver);
  db.flush();
  const transactions = t.mock.method(db, 'transaction');
  assert.deepEqual(new BotSelectorService(new SqliteBotSelectorRepository(db)).expire(), []);
  assert.deepEqual(f.communityService.advance(), { changed: false, started: [], polls: [] });
  await f.chatService.expireDeletedMessages();
  // The selector and community schedulers tick every second.
  await new Promise(resolve => setTimeout(resolve, 1_500));
  assert.equal(transactions.mock.callCount(), 0);
  assert.equal(db['dirty'], false);
  assert.equal(db['saveTimer'], null);
});

test('after a save, deleting a role or a channel still takes every row that names it (S-APP-1)', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const db = f.database.getDb();
  const owner = await f.human('Cascade owner');
  const member = await f.human('Cascade member');
  await f.roleRepo.create({
    id: 'cascade-role', name: 'Cascade', color: null, position: 2,
    permissions: DEFAULT_PERMISSIONS, isDefault: false, createdAt: Date.now(),
  });
  await f.roleRepo.assignRole(member.id, 'cascade-role');
  const channelId = text(record((await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'Cascade', type: 'TEXT' })).payload.channel).id);
  await owner.peer.request(MessageType.CHANNEL_UPDATE, {
    channelId, permissionOverwrites: [
      { roleId: 'cascade-role', allow: Permission.SEND_MESSAGES, deny: 0 },
      { userId: member.id, allow: Permission.ATTACH_FILES, deny: 0 },
    ],
  });
  const messageId = text((await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Hi @Cascade member' })).payload.id);
  assert.equal(await f.messageRepo.setReaction(messageId, member.id, '\u{1F44D}', true), 'changed');
  await f.attachmentRepo.create({
    id: randomUUID(), messageId: null, channelId, userId: member.id, kind: 'file', filename: 'pending.txt',
    originalName: 'pending.txt', mimeType: 'text/plain', sizeBytes: 1, width: null, height: null, durationMs: null,
    evicted: false, createdAt: Date.now(),
  });
  db.flush();
  assert.equal(foreignKeys(db), 1);

  assert.notEqual((await owner.peer.request(MessageType.ROLE_DELETE, { roleId: 'cascade-role' })).type, MessageType.SERVER_ERROR);
  assert.equal(await f.roleRepo.hasRole(member.id, 'cascade-role'), false);
  const rules = (await f.channelRepo.findById(channelId))?.permissionOverwrites ?? [];
  assert.equal(rules.some(rule => rule.roleId === 'cascade-role'), false);
  assert.equal(rules.some(rule => rule.userId === member.id), true);

  assert.equal((await owner.peer.request(MessageType.CHANNEL_DELETE, { channelId })).type, MessageType.CHANNEL_DELETED);
  for (const table of ['messages', 'mentions', 'message_attachments', 'channel_permission_overwrites']) {
    assert.deepEqual(ids(db, table, 'channel_id', `channel_id = '${channelId}'`), [], table);
  }
  assert.deepEqual(ids(db, 'message_reactions', 'message_id', `message_id = '${messageId}'`), []);
  assert.deepEqual(violations(db), []);
});

test('editing a private audience removes whoever left it, also after a public round trip (S-APP-2)', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Audience owner');
  const kept = await f.human('Audience kept');
  const dropped = await f.human('Audience dropped');
  f.database.getDb().flush();
  const community = f.communityService;
  await community.updateSettings(owner.id, { eventsEnabled: true });
  const now = Date.now();
  const draft: EventSave = {
    title: 'Private event', description: '', location: { kind: 'voice', channelId: channelOf(owner.auth, 'VOICE') },
    startsAt: now + 60_000, endsAt: now + 120_000, repeat: 'none', timeZone: 'UTC',
  };
  const only = (userIds: string[]) => ({ visibility: 'private' as const, userIds, roleIds: [] });
  let event = await community.saveEvent(owner.id, { ...draft, audience: only([kept.id, dropped.id]) });
  assert.equal(await community.canViewEvent(dropped.id, event), true);
  event = await community.saveEvent(owner.id, { ...draft, id: event.id, expectedRevision: event.revision, audience: only([kept.id]) });
  let stored = community.repository.event(event.id);
  assert.ok(stored);
  assert.deepEqual(stored.audience, only([kept.id]));
  assert.equal(await community.canViewEvent(dropped.id, stored), false);
  assert.equal(await community.canViewEvent(kept.id, stored), true);
  // Public and back must not bring the earlier selection back.
  event = await community.saveEvent(owner.id, { ...draft, id: event.id, expectedRevision: event.revision, audience: PUBLIC_AUDIENCE });
  event = await community.saveEvent(owner.id, { ...draft, id: event.id, expectedRevision: event.revision, audience: only([dropped.id]) });
  stored = community.repository.event(event.id);
  assert.deepEqual(stored?.audience, only([dropped.id]));
  // Someone removed while the editor still listed them does not fail the save on a foreign key.
  event = await community.saveEvent(owner.id, {
    ...draft, id: event.id, expectedRevision: event.revision,
    audience: { visibility: 'private', userIds: [kept.id, 'removed-member'], roleIds: ['removed-role'] },
  });
  assert.deepEqual(community.repository.event(event.id)?.audience, only([kept.id]));

  // Search reads the same rows to hide private polls.
  const polls = community['polls'];
  assert.ok(polls);
  const poll = polls.create(owner.id, {
    channelId: channelOf(owner.auth), question: 'Narrowed audience question', durationMinutes: 60,
    options: [{ label: 'Yes', emoji: null }, { label: 'No', emoji: null }], audience: only([kept.id, dropped.id]),
  }).poll;
  assert.equal((await f.searchService.search(dropped.id, { query: 'Narrowed' })).messages.length, 1);
  polls.edit(owner.id, {
    id: poll.id, expectedRevision: poll.revision, question: poll.question,
    options: poll.options.map(({ id, label, emoji }) => ({ id, label, emoji })),
    allowMultiple: false, anonymousVotes: false, images: [], maxVoters: null, liveAction: false, audience: only([kept.id]),
  });
  assert.equal(await polls.canView(dropped.id, polls.get(poll.id)), false);
  assert.equal((await f.searchService.search(dropped.id, { query: 'Narrowed' })).messages.length, 0);
  assert.equal((await f.searchService.search(kept.id, { query: 'Narrowed' })).messages.length, 1);
});

/** The members a resource's audience selects, as the access checks read them. */
function selectedUsers(db: IDatabaseDriver, type: string, id: string): string[] {
  return ids(db, 'community_resource_audience_users', 'user_id', `resource_type = '${type}' AND resource_id = '${id}'`);
}

function storedSnapshot(db: IDatabaseDriver, table: string, id: string): string {
  const row: { snapshot: string } = db.prepare(`SELECT snapshot FROM ${table} WHERE id = ?`).get(id);
  return row.snapshot;
}

test('the server rewriting an event on its own never brings back someone removed from its audience (S-APP-2)', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const db = f.database.getDb();
  const owner = await f.human('Recurring owner');
  const kept = await f.human('Recurring kept');
  const dropped = await f.human('Recurring dropped');
  const community = f.communityService;
  await community.updateSettings(owner.id, { eventsEnabled: true });
  const now = Date.now();
  const only = (userIds: string[]) => ({ visibility: 'private' as const, userIds, roleIds: [] });
  const draft: EventSave = {
    title: 'Daily sync', description: '', location: { kind: 'voice', channelId: channelOf(owner.auth, 'VOICE') },
    startsAt: now + 60_000, endsAt: now + 120_000, repeat: 'daily', timeZone: 'UTC', audience: only([kept.id, dropped.id]),
  };
  const created = await community.saveEvent(owner.id, draft, now);
  await community.saveEvent(owner.id, { ...draft, id: created.id, expectedRevision: created.revision, audience: only([kept.id]) }, now);
  const assertNarrowed = async (step: string) => {
    const stored = community.repository.event(created.id);
    assert.ok(stored, step);
    assert.deepEqual(stored.audience, only([kept.id]), step);
    assert.deepEqual(selectedUsers(db, 'event', created.id), [kept.id], step);
    const snapshot = storedSnapshot(db, 'server_events', created.id);
    assert.equal(snapshot.includes(dropped.id), false, step);
    assert.equal(snapshot.includes('"audience"'), false, `${step}: the tables are the only copy of the selection`);
    assert.equal(await community.canViewEvent(dropped.id, stored), false, step);
  };
  await assertNarrowed('after the edit');
  assert.deepEqual(community.advance(now + 60_000).started.map(event => event.id), [created.id]);
  await assertNarrowed('after starting on its own');
  community.advance(now + 120_000);
  const next = community.repository.event(created.id);
  assert.deepEqual([next?.status, next?.occurrence], ['scheduled', 1], 'the next occurrence was scheduled');
  await assertNarrowed('after scheduling the next occurrence');
});

test('an audience emptied by removals stays private to its creator and managers and never stops the schedulers (S-APP-1, S-APP-2)', async (t) => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const db = f.database.getDb();
  const owner = await f.human('Emptied owner');
  const solo = await f.human('Only selected member');
  const viewer = await f.human('Emptied viewer');
  const community = f.communityService;
  await community.updateSettings(owner.id, { eventsEnabled: true });
  const now = Date.now();
  const channelId = channelOf(owner.auth);
  const nobody = { visibility: 'private' as const, userIds: [], roleIds: [] };
  await f.roleRepo.create({
    id: 'only-role', name: 'Only role', color: null, position: 2,
    permissions: DEFAULT_PERMISSIONS, isDefault: false, createdAt: now,
  });
  await f.roleRepo.assignRole(viewer.id, 'only-role');
  const draft: EventSave = {
    title: 'Selected only', description: '', location: { kind: 'voice', channelId: channelOf(owner.auth, 'VOICE') },
    startsAt: now + 60_000, endsAt: now + 120_000, repeat: 'none', timeZone: 'UTC',
  };
  const privateEvent = await community.saveEvent(owner.id, {
    ...draft, audience: { visibility: 'private', userIds: [solo.id], roleIds: [] },
  }, now);
  const publicEvent = await community.saveEvent(owner.id, { ...draft, title: 'Open to all' }, now);
  const form = await community.createNativeForm(owner.id, {
    channelId, durationMinutes: 1, audience: { visibility: 'private', userIds: [], roleIds: ['only-role'] },
    form: { title: 'Role only', anonymous: false, fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }] },
  }, now);
  const createdBot = await f.botService.create(owner.id);
  assert.ok(createdBot.success);
  await f.bot(createdBot.token);
  const action = community.createLiveAction(createdBot.bot.id, owner.id, {
    channelId, invocationId: 'emptied-audience', title: 'Selected action', description: '', expiresAt: now + 600_000,
    content: { kind: 'form', form: { title: 'Answer', fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }] } },
    audience: { visibility: 'private', userIds: [solo.id], roleIds: [] },
  }, now);

  // The only member and the only role selected leave, and their rows with them.
  assert.equal((await owner.peer.request(MessageType.MEMBER_KICK, { targetUserId: solo.id })).type, MessageType.MEMBER_KICKED);
  assert.notEqual((await owner.peer.request(MessageType.ROLE_DELETE, { roleId: 'only-role' })).type, MessageType.SERVER_ERROR);

  // Every automatic rewrite still goes through, and nothing opens up.
  const result = community.advance(now + 60_000);
  assert.deepEqual(result.started.map(event => event.id).sort(), [privateEvent.id, publicEvent.id].sort());
  const startedEvent = community.repository.event(privateEvent.id);
  assert.ok(startedEvent);
  assert.equal(startedEvent.status, 'active');
  assert.deepEqual(startedEvent.audience, nobody);
  assert.equal(await community.canViewEvent(viewer.id, startedEvent), false);
  assert.equal(await community.canViewEvent(owner.id, startedEvent), true, 'its creator and the managers still see it');
  const closedForm = community.repository.nativeForm(form.id);
  assert.ok(closedForm);
  assert.equal(closedForm.closedAt, form.expiresAt);
  assert.deepEqual(closedForm.audience, nobody);
  assert.equal(await community.canViewNativeForm(viewer.id, closedForm), false);
  const renamed = community.updateLiveAction(createdBot.bot.id, { id: action.id, expectedRevision: action.revision, title: 'Renamed' }, now);
  assert.equal(renamed.title, 'Renamed');
  assert.deepEqual(community.repository.liveAction(action.id)?.audience, nobody);

  const visible = await community.snapshot(viewer.id);
  assert.deepEqual(visible.events.map(event => event.id), [publicEvent.id]);
  assert.deepEqual(violations(db), []);
});

test('removing a member keeps what they posted and the bots they added, and takes their votes, answers, rules and audience seats (D2)', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const db = f.database.getDb();
  const owner = await f.human('History owner');
  const member = await f.human('Departing member');
  const viewer = await f.human('Remaining viewer');
  const channelId = channelOf(owner.auth);
  const voiceId = channelOf(owner.auth, 'VOICE');
  const community = f.communityService;
  const polls = community['polls'];
  assert.ok(polls);
  const now = Date.now();
  const options = [{ label: 'Yes', emoji: null }, { label: 'No', emoji: null }];

  // What the member posted: a message with a file, a forum topic and a private poll.
  const filename = `${randomUUID()}.png`;
  const filePath = path.join(f.dataDir, 'attachments', filename);
  fs.writeFileSync(filePath, Buffer.from('89504e470d0a1a0a', 'hex'));
  const attachmentId = randomUUID();
  await f.attachmentRepo.create({
    id: attachmentId, messageId: null, channelId, userId: member.id, kind: 'image', filename, originalName: 'photo.png',
    mimeType: 'image/png', sizeBytes: 8, width: null, height: null, durationMs: null, evicted: false, createdAt: now,
  });
  const messageId = text((await member.peer.request(MessageType.CHAT_SEND, {
    channelId, content: 'Still part of the history', attachmentIds: [attachmentId],
  })).payload.id);
  const forum = (await f.channelService.createChannel({ name: 'Board', type: 'FORUM' })).channel;
  assert.ok(forum);
  const topic = await f.forumService.create(member.id, {
    id: randomUUID(), channelId: forum.id, title: 'Member topic', content: 'Opened by the member',
  }, () => true);
  const memberPoll = polls.create(member.id, {
    channelId, question: 'Only for the owner?', options, durationMinutes: 60,
    audience: { visibility: 'private', userIds: [owner.id], roleIds: [] },
  }).poll;

  // What only counted the member: a vote, an interest, an answer, a rule, an audience seat and a form.
  const ownerPoll = polls.create(owner.id, { channelId, question: 'Everyone?', options, durationMinutes: 60 }).poll;
  polls.vote(member.id, ownerPoll.id, [ownerPoll.options[0].id]);
  await community.updateSettings(owner.id, { eventsEnabled: true });
  const event = await community.saveEvent(owner.id, {
    title: 'Gathering', description: '', location: { kind: 'voice', channelId: voiceId },
    startsAt: now + 60_000, endsAt: now + 120_000, repeat: 'none', timeZone: 'UTC',
    audience: { visibility: 'private', userIds: [member.id, viewer.id], roleIds: [] },
  });
  await community.setInterest(member.id, event.id, true);
  const formDefinition = {
    title: 'Answer', anonymous: false, fields: [{ name: 'answer', label: 'Answer', type: 'text' as const, required: true }],
  };
  const form = await community.createNativeForm(owner.id, { channelId, durationMinutes: 10, form: formDefinition });
  await community.submitNativeForm(member.id, { id: form.id, expectedRevision: form.revision, values: { answer: 'Mine' } });
  const memberFormId = randomUUID();
  new SqliteCommunityRepository(db).saveNativeForm({
    id: memberFormId, channelId, creatorUserId: member.id, form: formDefinition, expiresAt: now + 600_000,
    closedAt: null, createdAt: now, revision: 0, audience: PUBLIC_AUDIENCE,
  });
  await owner.peer.request(MessageType.CHANNEL_UPDATE, {
    channelId: voiceId, permissionOverwrites: [{ userId: member.id, allow: 0, deny: Permission.SPEAK }],
  });
  const createdBot = await f.botService.create(member.id);
  assert.ok(createdBot.success && createdBot.token);
  const botId = createdBot.bot.id;
  const bot = await f.bot(createdBot.token);
  db.flush();

  assert.equal((await owner.peer.request(MessageType.MEMBER_KICK, { targetUserId: member.id })).type, MessageType.MEMBER_KICKED);

  assert.equal(await f.userRepo.findById(member.id), null);
  const history = await f.chatService.loadHistory(channelId, 100, undefined, undefined, owner.id);
  const kept = history.find(message => message.id === messageId);
  assert.equal(kept?.userNickname, 'Usuário Desconhecido', 'shown like any author who left');
  assert.equal(kept?.attachments?.length, 1);
  assert.ok(fs.existsSync(filePath));
  const posts = (await f.forumService.list(owner.id, { channelId: forum.id }, () => true)).posts;
  assert.deepEqual(posts.map(post => [post.channelId, post.authorId]), [[topic.post.channelId, member.id]]);
  assert.ok(history.some(message => message.id === memberPoll.messageId), 'the poll stays with its message');
  const viewerHistory = await f.chatService.loadHistory(channelId, 100, undefined, undefined, viewer.id);
  assert.equal(viewerHistory.some(message => message.id === messageId), true);
  assert.equal(viewerHistory.some(message => message.id === memberPoll.messageId), false, 'and stays private');

  assert.equal(polls.repository.voterCount(ownerPoll.id), 0);
  const stored = community.repository.event(event.id);
  assert.ok(stored);
  assert.deepEqual(stored.audience, { visibility: 'private', userIds: [viewer.id], roleIds: [] });
  assert.equal((await community.publicEvent(stored, owner.id)).interestedCount, 0);
  assert.equal(community.repository.nativeFormResponseCount(form.id), 0);
  assert.equal(community.repository.nativeForm(memberFormId), undefined);
  const voiceRules = (await f.channelRepo.findById(voiceId))?.permissionOverwrites ?? [];
  assert.equal(voiceRules.some(rule => rule.userId === member.id), false);
  // A bot belongs to the server: the one this member added keeps working.
  assert.equal((await f.botRepo.findById(botId))?.createdByUserId, member.id);
  assert.equal((await f.botService.list()).find(info => info.id === botId)?.online, true);
  assert.equal(bot.peer.messages.some(message => message.type === MessageType.BOT_REVOKED), false);
  assert.deepEqual(violations(db), []);
});

test('history pages never split messages sent in the same millisecond (S-APP-11)', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Pager');
  const channel = (await f.channelService.createChannel({ name: 'Burst', type: 'TEXT' })).channel;
  assert.ok(channel);
  const sent: string[] = [];
  const send = async (createdAt: number, content: string) => {
    const id = randomUUID();
    await f.messageRepo.create({ id, channelId: channel.id, userId: owner.id, content, createdAt });
    sent.push(id);
  };
  const burst = Date.now();
  for (let index = 0; index < 30; index++) await send(burst - 1_000 + index, `Before ${index}`);
  for (let index = 0; index < 150; index++) await send(burst, `Burst ${index}`);
  for (let index = 0; index < 5; index++) await send(burst + 1 + index, `After ${index}`);

  for (const limit of [100, 40, 7]) {
    const seen: string[] = [];
    let before: number | undefined;
    for (let page = 0; page < 50; page++) {
      const messages = await f.chatService.loadHistory(channel.id, limit, before, undefined, owner.id);
      if (messages.length === 0) break;
      seen.unshift(...messages.map(message => message.id));
      before = messages[0].createdAt;
    }
    assert.deepEqual(seen, sent, `every message once, in the order sent (limit ${limit})`);
  }
});

const REBUILT_TABLES = ['messages', 'message_attachments', 'forum_posts', 'native_polls', 'bots'];

/** What the rebuild must keep: columns, indexes, triggers and every foreign key but the ones to users. */
function schemaShape(db: IDatabaseDriver) {
  const objects: Array<{ type: string; name: string; sql: string }> = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name"
  ).all();
  return {
    objects: objects.map(object => ({ ...object, sql: object.sql.replace(/\s+/g, ' ').trim() })),
    tables: REBUILT_TABLES.map(table => ({
      table,
      columns: db.prepare('SELECT name, type, "notnull" AS required, dflt_value AS fallback, pk FROM pragma_table_info(?) ORDER BY cid').all(table),
      foreignKeys: db.prepare(`SELECT "table" AS parent, "from" AS child, "to" AS target, on_delete AS onDelete
        FROM pragma_foreign_key_list(?) ORDER BY "from"`).all(table),
    })),
  };
}

const LEGACY_ROWS = `
INSERT INTO server_meta (id, name, password_hash, created_at, afk_channel_id) VALUES ('server', 'Legacy', 'hash', 1, 'gone-afk');
INSERT INTO users (id, client_id, nickname, created_at, last_seen_at) VALUES
  ('owner', 'owner', 'Owner', 1, 1), ('stayer', 'stayer', 'Stayer', 1, 1), ('kicked', 'kicked', 'Kicked', 1, 1);
INSERT INTO roles (id, name, permissions, created_at) VALUES
  ('kept-role', 'Kept', 0, 1), ('stale-role', 'Stale', 0, 1), ('gone-role', 'Gone', 0, 1);
INSERT INTO channel_categories (id, server_id, name, created_at) VALUES
  ('category', 'server', 'Category', 1), ('gone-category', 'server', 'Gone', 1);
INSERT INTO channels (id, server_id, name, type, created_at, category_id, inherit_category_permissions, forum_parent_id) VALUES
  ('general', 'server', 'general', 'TEXT', 1, NULL, 0, NULL),
  ('gone', 'server', 'gone', 'TEXT', 1, NULL, 0, NULL),
  ('gone-afk', 'server', 'afk', 'VOICE', 1, NULL, 0, NULL),
  ('uncategorized', 'server', 'uncategorized', 'TEXT', 1, 'gone-category', 1, NULL),
  ('forum', 'server', 'forum', 'FORUM', 1, NULL, 0, NULL),
  ('topic', 'server', 'Topic', 'TEXT', 1, NULL, 0, 'forum'),
  ('gone-forum', 'server', 'gone forum', 'FORUM', 1, NULL, 0, NULL),
  ('orphan-topic', 'server', 'Orphan topic', 'TEXT', 1, NULL, 0, 'gone-forum');
INSERT INTO forum_posts (channel_id, forum_id, author_id, created_at) VALUES
  ('topic', 'forum', 'kicked', 1), ('orphan-topic', 'gone-forum', 'kicked', 1);
INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES
  ('kicked-message', 'general', 'kicked', 'kicked member searchable history', 10),
  ('owner-message', 'general', 'owner', 'hello @Kicked', 11),
  ('topic-message', 'topic', 'kicked', 'topic opener', 12),
  ('kicked-poll-message', 'general', 'kicked', 'Kicked poll?', 13),
  ('gone-message', 'gone', 'owner', 'gone searchable history', 14),
  ('gone-poll-message', 'gone', 'owner', 'Gone poll?', 15),
  ('orphan-topic-message', 'orphan-topic', 'kicked', 'orphan topic opener', 16);
INSERT INTO message_attachments (id, message_id, channel_id, user_id, kind, filename, original_name, mime_type, size_bytes, created_at) VALUES
  ('kicked-file', 'kicked-message', 'general', 'kicked', 'file', 'kicked.txt', 'kicked.txt', 'text/plain', 1, 10),
  ('kicked-pending', NULL, 'general', 'kicked', 'file', 'pending.txt', 'pending.txt', 'text/plain', 1, 10),
  ('gone-file', 'gone-message', 'gone', 'owner', 'file', 'gone.txt', 'gone.txt', 'text/plain', 1, 14);
INSERT INTO mentions (id, user_id, channel_id, message_id, created_at) VALUES
  ('stayer-mention', 'stayer', 'general', 'owner-message', 11), ('gone-mention', 'stayer', 'gone', 'gone-message', 14);
INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ('kicked-message', 'stayer', 'like'), ('gone-message', 'stayer', 'like');
INSERT INTO message_deletion_backups (message_id, deleted_at, expires_at, content) VALUES ('gone-message', 14, 99, 'gone');
INSERT INTO native_polls (id, message_id, channel_id, creator_user_id, question, options_json, created_at, audience_json) VALUES
  ('kicked-poll', 'kicked-poll-message', 'general', 'kicked', 'Kicked poll?', '[]', 13,
    '{"visibility":"private","userIds":["owner"],"roleIds":[]}'),
  ('gone-poll', 'gone-poll-message', 'gone', 'owner', 'Gone poll?', '[]', 15, '{"visibility":"public"}');
INSERT INTO native_poll_votes (poll_id, user_id, option_id, created_at, updated_at) VALUES
  ('kicked-poll', 'owner', 'yes', 13, 13), ('kicked-poll', 'kicked', 'no', 13, 13), ('gone-poll', 'stayer', 'yes', 15, 15);
INSERT INTO server_events (id, snapshot, status, starts_at) VALUES
  ('event', '{"id":"event","title":"Private  gathering","location":{"kind":"voice","channelId":"general"},"audience":{"visibility":"private","userIds":["stayer"],"roleIds":["kept-role"]}}', 'scheduled', 100),
  ('unparsed-event', '{"id":"unparsed-event","title":"Corrupted audience","location":{"kind":"external","label":"Somewhere secret"},"audience":{"visibility":"private"}}', 'scheduled', 200),
  ('gone-room-event', '{"id":"gone-room-event","title":"Lost room","location":{"kind":"text","channelId":"gone"}}', 'ended', 300),
  ('public-event', '{"id":"public-event","title":"Open meetup","location":{"kind":"voice","channelId":"general"}}', 'scheduled', 50),
  ('gone-event', '{"id":"gone-event"}', 'scheduled', 100);
INSERT INTO server_event_interest (event_id, user_id) VALUES ('event', 'stayer'), ('event', 'kicked'), ('gone-event', 'stayer');
INSERT INTO community_resource_audiences (resource_type, resource_id) VALUES
  ('event', 'event'), ('event', 'unparsed-event'), ('event', 'gone-room-event'), ('event', 'gone-event'), ('event', 'ghost'),
  ('poll', 'kicked-poll'), ('native_form', 'owner-form'), ('live_action', 'kept-action');
INSERT INTO community_resource_audience_users (resource_type, resource_id, user_id) VALUES
  ('event', 'event', 'stayer'), ('event', 'event', 'owner'), ('event', 'event', 'kicked'),
  ('event', 'unparsed-event', 'owner'), ('event', 'gone-room-event', 'stayer'), ('event', 'gone-event', 'stayer'),
  ('event', 'ghost', 'stayer'), ('poll', 'kicked-poll', 'owner'), ('poll', 'kicked-poll', 'stayer');
INSERT INTO community_resource_audience_roles (resource_type, resource_id, role_id) VALUES
  ('event', 'event', 'kept-role'), ('event', 'event', 'stale-role'), ('event', 'event', 'gone-role');
INSERT INTO native_live_forms (id, channel_id, creator_user_id, expires_at, snapshot) VALUES
  ('owner-form', 'general', 'owner', 100, '{"form":{"title":"Private signup"}}'), ('kicked-form', 'general', 'kicked', 100, '{}'),
  ('gone-form', 'gone', 'owner', 100, '{}');
INSERT INTO native_live_form_responses (form_id, user_id, values_json, created_at, updated_at) VALUES
  ('owner-form', 'stayer', '{}', 1, 1), ('owner-form', 'kicked', '{}', 1, 1), ('kicked-form', 'stayer', '{}', 1, 1);
INSERT INTO bots (id, name, token_hash, created_by_user_id, created_at) VALUES
  ('owner-bot', 'Owner bot', 'owner-hash', 'owner', 1), ('kicked-bot', 'Kicked bot', 'kicked-hash', 'kicked', 1),
  ('gone-bot', 'Revoked bot', 'gone-hash', 'owner', 1);
INSERT INTO bot_permissions (bot_id, permissions_json) VALUES ('owner-bot', '{}'), ('kicked-bot', '{}'), ('gone-bot', '{}');
INSERT INTO bot_voice_restrictions (bot_id) VALUES ('kicked-bot'), ('gone-bot');
INSERT INTO bot_selectors (id, bot_id, channel_id, snapshot) VALUES
  ('kept-selector', 'owner-bot', 'general', '{}'), ('gone-selector', 'owner-bot', 'gone', '{}'),
  ('gone-bot-selector', 'gone-bot', 'general', '{}');
INSERT INTO bot_live_actions (id, bot_id, channel_id, expires_at, snapshot) VALUES
  ('kept-action', 'owner-bot', 'general', 100, '{"title":"Private vote"}'), ('kicked-action', 'kicked-bot', 'general', 100, '{}'),
  ('gone-bot-action', 'gone-bot', 'general', 100, '{}');
INSERT INTO user_roles (user_id, role_id) VALUES ('stayer', 'kept-role'), ('stayer', 'gone-role'), ('kicked', 'kept-role');
INSERT INTO user_voice_restrictions (user_id) VALUES ('stayer'), ('kicked');
INSERT INTO channel_allowed_roles (channel_id, role_id) VALUES ('general', 'kept-role'), ('general', 'gone-role');
INSERT INTO channel_permission_overwrites (channel_id, target_id, role_id, user_id) VALUES
  ('general', 'role:kept-role', 'kept-role', NULL), ('general', 'role:gone-role', 'gone-role', NULL),
  ('general', 'user:kicked', NULL, 'kicked'), ('gone', '@everyone', NULL, NULL);
INSERT INTO category_allowed_roles (category_id, role_id) VALUES ('category', 'kept-role'), ('category', 'gone-role');
INSERT INTO category_permission_overwrites (category_id, target_id, role_id, user_id) VALUES
  ('category', 'user:stayer', NULL, 'stayer'), ('category', 'role:gone-role', 'gone-role', NULL),
  ('gone-category', '@everyone', NULL, NULL);
-- Months of deletions without foreign keys.
DELETE FROM roles WHERE id = 'gone-role';
DELETE FROM channels WHERE id IN ('gone', 'gone-afk', 'gone-forum');
DELETE FROM channel_categories WHERE id = 'gone-category';
DELETE FROM server_events WHERE id = 'gone-event';
DELETE FROM bots WHERE id = 'gone-bot';
`;

test('the integrity migration keeps removed members\' history and bots, narrows stale audiences and removes true orphans (S-APP-1, S-APP-2, D2)', async (t) => {
  const folder = temporaryFolder();
  const filename = path.join(folder, 'server.db');
  const opened: Array<{ close(): void }> = [];
  t.after(() => {
    for (const database of opened) database.close();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const legacy = await SqlJsDriver.create(filename);
  opened.push(legacy);
  // Production saved without foreign keys for months (S-APP-1).
  legacy.setForeignKeys(false);
  const migrations = path.join(__dirname, 'infrastructure', 'database', 'migrations');
  legacy.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const file of fs.readdirSync(migrations).filter(name => name.endsWith('.sql') && name < '057').sort()) {
    legacy.transaction(() => {
      legacy.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
      legacy.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, 0);
    })();
  }
  const before = schemaShape(legacy);
  legacy.exec(LEGACY_ROWS);
  // Removing a member deleted their roles and unread mentions, nothing more.
  await new SqliteUserRepository(legacy).delete('kicked');
  const rowids: Array<{ id: string; position: number }> = legacy.prepare('SELECT id, rowid AS position FROM messages').all();
  legacy.close();

  const warnings = t.mock.method(Logger, 'warn', () => undefined);
  const database = await DatabaseConnection.create(filename);
  opened.push(database);
  const db = database.getDb();
  assert.equal(foreignKeys(db), 1);
  assert.deepEqual(violations(db), []);

  // The owner gets the private events, forms and live actions to review: names, channels and dates only.
  const review = warnings.mock.calls.filter(call => call.arguments[0] === 'DATABASE').map(call => String(call.arguments[1]));
  assert.match(review[0], /^Revise quem pode ver/);
  assert.match(review[1], /^Review who can see/);
  assert.deepEqual(review.slice(2), [
    '- Evento / Event "Private gathering" · #general · 1970-01-01 00:00 UTC',
    '- Evento / Event "Corrupted audience" · local externo / external location · 1970-01-01 00:00 UTC',
    '- Evento / Event "Lost room" · canal removido / deleted channel · 1970-01-01 00:00 UTC',
    '- Formulário / Form "Private signup" · #general · 1970-01-01 00:00 UTC',
    '- Ação ao vivo / Live action "Private vote" · #general · 1970-01-01 00:00 UTC',
  ]);
  for (const line of review) assert.doesNotMatch(line, /stayer|owner|kicked|Somewhere secret/, line);

  // The rebuilt tables lost only their references to users.
  const after = schemaShape(db);
  // Later migrations may add or redefine objects of their own; everything else must come back unchanged.
  const later = fs.readdirSync(migrations).filter(name => name.endsWith('.sql') && name >= '058')
    .map(name => fs.readFileSync(path.join(migrations, name), 'utf8')).join('\n');
  const untouched = (object: { name: string }) => !later.includes(object.name);
  assert.deepEqual(after.objects.filter(untouched), before.objects.filter(untouched), 'indexes and triggers are recreated as they were');
  for (const [index, table] of before.tables.entries()) {
    assert.deepEqual(after.tables[index].columns, table.columns, table.table);
    const expected: Array<{ parent: string }> = table.foreignKeys;
    assert.deepEqual(after.tables[index].foreignKeys, expected.filter(foreignKey => foreignKey.parent !== 'users'), table.table);
  }

  // D2: what the removed member posted stays, at the same rowids the search index points to.
  assert.deepEqual(ids(db, 'messages'), ['kicked-message', 'kicked-poll-message', 'owner-message', 'topic-message']);
  const kept = new Set(ids(db, 'messages'));
  const preserved: Array<{ id: string; position: number }> = db.prepare('SELECT id, rowid AS position FROM messages').all();
  assert.deepEqual(preserved.sort((a, b) => a.id.localeCompare(b.id)),
    rowids.filter(row => kept.has(row.id)).sort((a, b) => a.id.localeCompare(b.id)));
  const search = (query: string): string[] => (db.prepare(`SELECT m.id AS id FROM message_search_fts
    JOIN messages m ON m.rowid = message_search_fts.docid WHERE message_search_fts MATCH ? ORDER BY m.id`).all(query) as Array<{ id: string }>)
    .map(row => row.id);
  assert.deepEqual(search('searchable'), ['kicked-message']);
  assert.deepEqual(ids(db, 'message_attachments'), ['kicked-file', 'kicked-pending']);
  assert.deepEqual(ids(db, 'forum_posts', 'channel_id'), ['topic']);
  assert.deepEqual(ids(db, 'native_polls'), ['kicked-poll']);
  assert.deepEqual(ids(db, 'channels'), ['forum', 'general', 'topic', 'uncategorized']);

  // S-APP-2: audiences shrink to what each resource last saved; nothing is added.
  assert.deepEqual(ids(db, 'community_resource_audience_users', "resource_type || ':' || resource_id || ':' || user_id"),
    ['event:event:stayer', 'event:gone-room-event:stayer', 'event:unparsed-event:owner', 'poll:kicked-poll:owner']);
  assert.deepEqual(ids(db, 'community_resource_audience_roles', "resource_id || ':' || role_id"), ['event:kept-role']);
  assert.deepEqual(ids(db, 'community_resource_audiences', "resource_type || ':' || resource_id"), [
    'event:event', 'event:gone-room-event', 'event:unparsed-event', 'live_action:kept-action', 'native_form:owner-form',
    'poll:kicked-poll',
  ]);

  // What the cascades would have removed is gone; pointers to removed rows fall back to their default.
  const server: { afk: string | null } = db.prepare('SELECT afk_channel_id AS afk FROM server_meta').get();
  assert.equal(server.afk, null);
  const uncategorized: { category: string | null; inherits: number } = db.prepare(
    "SELECT category_id AS category, inherit_category_permissions AS inherits FROM channels WHERE id = 'uncategorized'").get();
  assert.deepEqual({ ...uncategorized }, { category: null, inherits: 0 });
  assert.deepEqual(ids(db, 'mentions'), ['stayer-mention']);
  // #834: the search index follows the chat rule; "@Kicked" names a removed member, nobody else.
  assert.deepEqual(ids(db, 'message_search_mentions', "message_id || ':' || user_id"), []);
  assert.deepEqual(ids(db, 'message_reactions', 'message_id'), ['kicked-message']);
  assert.deepEqual(ids(db, 'message_deletion_backups', 'message_id'), []);
  assert.deepEqual(ids(db, 'native_poll_votes', "poll_id || ':' || user_id"), ['kicked-poll:owner']);
  assert.deepEqual(ids(db, 'server_event_interest', "event_id || ':' || user_id"), ['event:stayer']);
  assert.deepEqual(ids(db, 'native_live_forms'), ['owner-form']);
  assert.deepEqual(ids(db, 'native_live_form_responses', "form_id || ':' || user_id"), ['owner-form:stayer']);
  // Bots belong to the server: the one the removed member added stays; a revoked one leaves nothing behind.
  assert.deepEqual(ids(db, 'bots', "id || ':' || created_by_user_id"), ['kicked-bot:kicked', 'owner-bot:owner']);
  assert.deepEqual(ids(db, 'bot_permissions', 'bot_id'), ['kicked-bot', 'owner-bot']);
  assert.deepEqual(ids(db, 'bot_voice_restrictions', 'bot_id'), ['kicked-bot']);
  assert.deepEqual(ids(db, 'bot_selectors'), ['kept-selector']);
  assert.deepEqual(ids(db, 'bot_live_actions'), ['kept-action', 'kicked-action']);
  assert.deepEqual(ids(db, 'user_roles', "user_id || ':' || role_id"), ['stayer:kept-role']);
  assert.deepEqual(ids(db, 'user_voice_restrictions', 'user_id'), ['stayer']);
  assert.deepEqual(ids(db, 'channel_allowed_roles', "channel_id || ':' || role_id"), ['general:kept-role']);
  assert.deepEqual(ids(db, 'channel_permission_overwrites', "channel_id || ':' || target_id"), ['general:role:kept-role']);
  assert.deepEqual(ids(db, 'category_allowed_roles', "category_id || ':' || role_id"), ['category:kept-role']);
  assert.deepEqual(ids(db, 'category_permission_overwrites', "category_id || ':' || target_id"), ['category:user:stayer']);

  // The startup reconciliation then keeps the removed member's file and collects the orphan's.
  const dataDir = path.dirname(filename);
  const storage = new AttachmentStorageService(dataDir);
  for (const name of ['kicked.txt', 'gone.txt']) fs.writeFileSync(path.join(dataDir, 'attachments', name), 'file');
  const rateLimiter = new RateLimiter();
  t.after(() => rateLimiter.dispose());
  await new AttachmentService(new SqliteAttachmentRepository(db), new SqliteServerRepository(db), storage, rateLimiter).reconcile();
  assert.ok(fs.existsSync(path.join(dataDir, 'attachments', 'kicked.txt')));
  assert.equal(fs.existsSync(path.join(dataDir, 'attachments', 'gone.txt')), false);

  // The recreated triggers still guard and index.
  db.prepare("INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES ('fresh', 'general', 'stayer', 'fresh searchable words', 20)").run();
  assert.deepEqual(search('searchable'), ['fresh', 'kicked-message']);
  db.prepare("UPDATE forum_posts SET locked = 1 WHERE channel_id = 'topic'").run();
  assert.throws(() => db.prepare("INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES ('late', 'topic', 'stayer', 'late', 21)").run(),
    /not accepting replies/);
  assert.throws(() => db.prepare("UPDATE forum_posts SET closed = 2 WHERE channel_id = 'topic'").run(), /CHECK constraint failed/);
  db.prepare("UPDATE messages SET deleted_at = 30 WHERE id = 'kicked-message'").run();
  assert.deepEqual(ids(db, 'message_reactions', 'message_id'), []);
  db.prepare("DELETE FROM native_polls WHERE id = 'kicked-poll'").run();
  assert.deepEqual(ids(db, 'community_resource_audience_users', 'resource_id', "resource_type = 'poll'"), []);
  assert.deepEqual(violations(db), []);

  database.close();
  const listed = warnings.mock.callCount();
  opened.push(await DatabaseConnection.create(filename));
  assert.equal(warnings.mock.callCount(), listed, 'only the start that applies the repair lists them');
});
