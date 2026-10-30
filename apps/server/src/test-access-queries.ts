import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { WebSocket } from 'ws';
import {
  ADMIN_PERMISSIONS, DEFAULT_PERMISSIONS, LIMITS, MessageType, PROTOCOL_VERSION, Permission, ProtocolErrorCode, botSettingsListResponseSchema,
  canAccessChannel, createProtocolOffer, getChannelPermissions, hasChannelPermission, hasPermission, resolveMemberPermissions,
  type BotCapability, type ChannelSummary, type ProtocolMessage,
} from '@monky/shared';
import type { IDatabaseDriver } from './infrastructure/database/SqliteWrapper';
import { SqliteBotPermissionRepository } from './infrastructure/database/SqliteBotPermissionRepository';
import { SqliteBotSelectorRepository } from './infrastructure/database/SqliteBotSelectorRepository';
import { SqliteForumRepository } from './infrastructure/database/SqliteForumRepository';
import { BotPermissionService } from './application/services/BotPermissionService';
import { BotScreenService } from './application/services/BotScreenService';
import { BotSelectorService } from './application/services/BotSelectorService';
import { BotScreenHandler } from './infrastructure/websocket/BotScreenHandler';
import { BotSelectorHandler } from './infrastructure/websocket/BotSelectorHandler';
import type { BotInteractionSession } from './infrastructure/websocket/BotInteractionHandler';
import { createFixture } from './testFixtures/bots';

/**
 * Query budgets for the access checks (S-APP-5, S-APP-7, BOTS-3, BOTS-5).
 * The driver prepares one statement per get, all or run, so counting those
 * counts what reaches SQLite. Each budget sits well below what the same
 * operation cost when access was read again for every item.
 */
function countStatements(db: IDatabaseDriver) {
  const prepare = db.prepare.bind(db);
  const issued: string[] = [];
  db.prepare = (sql: string) => {
    const statement = prepare(sql);
    const counted = <P extends unknown[], R>(run: (...params: P) => R) => (...params: P): R => {
      issued.push(sql);
      return run(...params);
    };
    return { get: counted(statement.get), all: counted(statement.all), run: counted(statement.run) };
  };
  return {
    async measure<T>(operation: () => Promise<T>): Promise<{ result: T; count: number; sql: string[] }> {
      issued.length = 0;
      const result = await operation();
      return { result, count: issued.length, sql: [...issued] };
    },
    restore: () => { db.prepare = prepare; },
  };
}

async function setup(t: test.TestContext) {
  const f = await createFixture();
  t.after(() => f.dispose());
  const db = f.database.getDb();
  const counter = countStatements(db);
  t.after(() => counter.restore());
  const owner = await f.human('Access owner');
  const server = await f.serverRepo.getServer();
  assert.ok(server);
  const listed = await f.channelService.listChannels();
  const textId = listed.find(channel => channel.type === 'TEXT')?.id;
  const voiceId = listed.find(channel => channel.type === 'VOICE')?.id;
  assert.ok(textId && voiceId);
  const forums = new SqliteForumRepository(db);
  const role = async (name: string, permissions = 0) => {
    const id = randomUUID();
    await f.roleRepo.create({ id, name, color: null, position: 1, permissions, isDefault: false, createdAt: 1 });
    return id;
  };
  const member = async (nickname: string, roleIds: string[] = []) => {
    const id = randomUUID();
    await f.userRepo.create({ id, clientId: id, publicKey: null, nickname, avatarPath: null, createdAt: 1, lastSeenAt: 1 });
    for (const roleId of roleIds) await f.roleRepo.assignRole(id, roleId);
    return id;
  };
  const channel = async (payload: Parameters<typeof f.channelService.createChannel>[0]) => {
    const created = await f.channelService.createChannel(payload);
    assert.ok(created.channel, created.errorMessage);
    return created.channel;
  };
  const topic = (forum: ChannelSummary, title: string) => {
    const id = randomUUID();
    forums.create(id, forum, owner.id, title, Date.now());
    return id;
  };
  const bot = async (capabilities: BotCapability[]) => {
    const created = await f.botService.create(owner.id);
    assert.ok(created.success);
    if (capabilities.length) {
      const { permissions } = f.botPermissions.declare(created.bot.id, capabilities);
      f.botPermissions.approve(owner.id, { botId: created.bot.id, expectedRevision: permissions.revision, granted: capabilities });
    }
    return created.bot.id;
  };
  return { ...f, db, counter, owner, server, textId, voiceId, role, member, channel, topic, bot };
}

/** How access was decided before S-APP-5, read straight from the repositories for each check. */
async function previousAccess(f: Awaited<ReturnType<typeof setup>>, userId: string, channelId: string, permission: Permission) {
  const channel = (await f.channelRepo.listByServerId(f.server.id)).find(entry => entry.id === channelId);
  if (!channel) return false;
  const bot = new BotPermissionService(new SqliteBotPermissionRepository(f.db)).getChannelPermissions(userId);
  const server = await f.serverRepo.getServer();
  const roles = bot === undefined ? await f.roleRepo.listRolesForUser(userId) : [];
  const permissions = bot ?? (server?.ownerUserId === userId
    ? ADMIN_PERMISSIONS : resolveMemberPermissions(server?.everyonePermissions ?? DEFAULT_PERMISSIONS, roles));
  const roleIds = roles.map(role => role.id);
  if (permission === Permission.MANAGE_CHANNELS || permission === Permission.MOVE_MEMBERS) return hasPermission(permissions, permission);
  return canAccessChannel(channel, permissions, roleIds, bot !== undefined, userId) &&
    hasChannelPermission(channel, permissions, roleIds, permission, bot !== undefined, userId);
}

test('one channel read resolves the same access as the full listing, categories and forum topics included', async t => {
  const f = await setup(t);
  const readers = await f.role('Readers');
  assert.equal((await f.channelService.mutateCategory('create', {
    name: 'Private category', isPrivate: true, allowedRoleIds: [readers],
  })).success, true);
  const category = (await f.channelService.listCategories()).find(entry => entry.name === 'Private category');
  assert.ok(category);
  await f.channel({ name: 'inherits', type: 'TEXT', categoryId: category.id, inheritCategoryPermissions: true });
  await f.channel({ name: 'own-rules', type: 'TEXT', categoryId: category.id, inheritCategoryPermissions: false });
  await f.channel({ name: 'private', type: 'TEXT', isPrivate: true, allowedRoleIds: [readers] });
  const privateForum = await f.channel({ name: 'private-forum', type: 'FORUM', isPrivate: true, allowedRoleIds: [readers] });
  f.topic(privateForum, 'Private topic');
  const categorizedForum = await f.channel({ name: 'categorized-forum', type: 'FORUM', categoryId: category.id, inheritCategoryPermissions: true });
  f.topic(categorizedForum, 'Categorized topic');
  const listed = await f.channelRepo.listByServerId(f.server.id);
  assert.ok(listed.length >= 9);
  for (const channel of listed) assert.deepEqual(await f.channelRepo.findById(channel.id), channel, channel.name);
});

test('every channel check answers as before, one at a time, from a scope or for a whole audience', async t => {
  const f = await setup(t);
  const managers = await f.role('Managers', Permission.MANAGE_CHANNELS);
  const readers = await f.role('Readers');
  const writers = await f.role('Writers', Permission.SEND_MESSAGES);
  await f.permissions.updateEveryonePermissions(DEFAULT_PERMISSIONS & ~Permission.SEND_MESSAGES);
  const manager = await f.member('Manager', [managers]);
  const reader = await f.member('Reader', [readers]);
  const writer = await f.member('Writer', [readers, writers]);
  const roleless = await f.member('Roleless');
  const excluded = await f.member('Excluded', [readers]);
  const admin = await f.member('Administrator');
  await f.roleService.assignAdminRole(admin);
  const readingBot = await f.bot(['read_messages', 'send_messages']);
  const unreviewedBot = await f.bot([]);
  assert.equal((await f.channelService.mutateCategory('create', {
    name: 'Readers only', isPrivate: true, allowedRoleIds: [readers],
  })).success, true);
  const category = (await f.channelService.listCategories()).find(entry => entry.name === 'Readers only');
  assert.ok(category);
  const forum = await f.channel({ name: 'forum', type: 'FORUM', isPrivate: true, allowedRoleIds: [readers] });
  const channels = [
    f.textId, f.voiceId,
    (await f.channel({ name: 'private', type: 'TEXT', isPrivate: true, allowedRoleIds: [readers] })).id,
    (await f.channel({ name: 'rules', type: 'TEXT', permissionOverwrites: [
      { roleId: null, allow: 0, deny: Permission.READ_MESSAGES },
      { roleId: readers, allow: Permission.READ_MESSAGES | Permission.ATTACH_FILES, deny: 0 },
      { userId: excluded, allow: 0, deny: Permission.VIEW_CHANNEL },
    ] })).id,
    (await f.channel({ name: 'inherits', type: 'TEXT', categoryId: category.id, inheritCategoryPermissions: true })).id,
    (await f.channel({ name: 'private-voice', type: 'VOICE', isPrivate: true, allowedRoleIds: [readers] })).id,
    forum.id, f.topic(forum, 'Topic'), 'missing-channel',
  ];
  const users = [f.owner.id, admin, manager, reader, writer, roleless, excluded, readingBot, unreviewedBot];
  const permissions = [Permission.VIEW_CHANNEL, Permission.READ_MESSAGES, Permission.SEND_MESSAGES,
    Permission.ATTACH_FILES, Permission.SPEAK, Permission.USE_BOT_COMMANDS, Permission.MANAGE_CHANNELS];
  const scope = f.channelService.accessScope();
  const listedScope = f.channelService.accessScope(await f.channelService.listChannels());
  let allowedSome = false;
  let deniedSome = false;
  for (const channelId of channels) {
    for (const permission of permissions) {
      const audience = await f.channelService.membersWithAccess(channelId, users, [permission]);
      for (const userId of users) {
        const expected = await previousAccess(f, userId, channelId, permission);
        const label = `${userId} ${channelId} ${Permission[permission]}`;
        assert.equal(await f.channelService.canUserAccessChannel(userId, channelId, permission), expected, label);
        assert.equal(await scope.can(userId, channelId, permission), expected, label);
        assert.equal(await listedScope.can(userId, channelId, permission), expected, label);
        assert.equal(audience.has(userId), expected, label);
        allowedSome ||= expected;
        deniedSome ||= !expected;
      }
    }
    for (const userId of users) {
      const channel = (await f.channelRepo.listByServerId(f.server.id)).find(entry => entry.id === channelId);
      const base = await f.channelService.getAccessContext(userId);
      const inChannel = await f.channelService.getAccessContext(userId, channelId);
      const expected = !channel ? 0 : base.isBot
        ? channel.isPrivate ? 0 : getChannelPermissions(channel, base.permissions, [], true)
        : getChannelPermissions(channel, base.permissions, base.roleIds, false, userId);
      assert.equal(inChannel.permissions, expected, `${userId} ${channelId}`);
      assert.deepEqual((await scope.channelContext(userId, channelId)).permissions, expected);
    }
  }
  assert.ok(allowedSome && deniedSome, 'the matrix covers both answers');
});

test('a page of history checks its channel once, finds its polls together and keeps private ones private', async t => {
  const f = await setup(t);
  const author = await f.member('History author');
  const viewer = await f.member('History viewer');
  const insider = await f.member('Poll audience');
  let previous: string | undefined;
  for (let index = 0; index < 100; index++) {
    const id = randomUUID();
    await f.messageRepo.create({ id, channelId: f.textId, userId: author, content: `message ${index}`, createdAt: 1_000 + index,
      isSystem: false, replyToMessageId: index % 20 === 19 ? previous : undefined });
    previous = id;
  }
  const page = await f.counter.measure(() => f.chatService.loadHistory(f.textId, 100, undefined, undefined, viewer));
  assert.equal(page.result.length, 100);
  assert.equal(page.result.filter(message => message.reply).length, 5);
  // About 2,800 statements when every message checked its channel twice.
  assert.ok(page.count <= 40, `history page took ${page.count} statements`);

  const polls = f.communityService['polls'];
  assert.ok(polls);
  const { poll } = polls.create(f.owner.id, {
    channelId: f.textId, question: 'Private poll', durationMinutes: 10,
    options: [{ label: 'Yes', emoji: null }, { label: 'No', emoji: null }],
    audience: { visibility: 'private', userIds: [insider], roleIds: [] },
  });
  const latest = async (userId: string) => (await f.chatService.loadHistory(f.textId, 5, undefined, undefined, userId)).map(message => message.id);
  assert.equal((await latest(viewer)).includes(poll.messageId), false);
  assert.equal((await latest(insider)).includes(poll.messageId), true);
  const stored = await f.messageRepo.findById(poll.messageId);
  assert.ok(stored);
  assert.deepEqual(await f.chatService.hydrateMessages([stored], viewer), []);
  assert.equal((await f.chatService.hydrateMessages([stored], insider))[0]?.poll?.id, poll.id);

  const readers = await f.role('Hidden readers');
  const hidden = await f.channel({ name: 'hidden', type: 'TEXT', permissionOverwrites: [
    { roleId: null, allow: 0, deny: Permission.READ_MESSAGES },
    { roleId: readers, allow: Permission.READ_MESSAGES, deny: 0 },
  ] });
  for (let index = 0; index < 20; index++) {
    await f.messageRepo.create({ id: randomUUID(), channelId: hidden.id, userId: author, content: `hidden ${index}`, createdAt: 5_000 + index, isSystem: false });
  }
  const denied = await f.counter.measure(() => f.chatService.loadHistory(hidden.id, 100, undefined, undefined, viewer));
  assert.deepEqual(denied.result, []);
  assert.ok(denied.count <= 15, `a denied page took ${denied.count} statements`);
  await f.roleRepo.assignRole(viewer, readers);
  assert.equal((await f.chatService.loadHistory(hidden.id, 100, undefined, undefined, viewer)).length, 20);
});

test('an @everyone audience is resolved in a fixed number of reads, with the answers of single checks', async t => {
  const f = await setup(t);
  const readers = await f.role('Audience readers');
  const users: string[] = [];
  for (let index = 0; index < 200; index++) users.push(await f.member(`Member ${index}`, index % 3 === 0 ? [readers] : []));
  const bot = await f.bot(['read_messages']);
  users.push(bot, f.owner.id);
  const channel = await f.channel({ name: 'readers', type: 'TEXT', isPrivate: true, allowedRoleIds: [readers] });
  const audience = await f.counter.measure(() => f.channelService.membersWithAccess(channel.id, users, [Permission.READ_MESSAGES]));
  // About 4,600 statements when each of 200 members was checked twice.
  assert.ok(audience.count <= 10, `the audience took ${audience.count} statements`);
  for (const userId of users) {
    assert.equal(audience.result.has(userId), await f.channelService.canUserAccessChannel(userId, channel.id, Permission.READ_MESSAGES));
  }
  assert.equal(audience.result.size, 68, 'role members and the owner; bots stay out of private channels');
  assert.deepEqual(await f.channelService.membersWithAccess('missing-channel', users), new Set());
});

test('an @everyone mention checks its whole audience at once and pings only readers', async t => {
  const f = await setup(t);
  const readers = await f.role('Mention readers');
  const channel = await f.channel({ name: 'mentions', type: 'TEXT', isPrivate: true, allowedRoleIds: [readers] });
  const join = async (count: number) => {
    for (let index = 0; index < count; index++) await f.member(`Mentioned ${randomUUID()}`, index % 3 === 0 ? [readers] : []);
  };
  const mention = async () => {
    const sent = await f.counter.measure(() => f.chatService.sendMessage(f.owner.id, channel.id, '@todos hello'));
    const message = sent.result.message;
    assert.ok(sent.result.success && message, sent.result.errorMessage);
    const pinged: Array<{ userId: string }> = f.db.prepare('SELECT user_id AS userId FROM mentions WHERE message_id = ?').all(message.id);
    const audience = await f.channelService.membersWithAccess(channel.id, (await f.userRepo.listAll()).map(user => user.id),
      [Permission.VIEW_CHANNEL, Permission.READ_MESSAGES]);
    audience.delete(f.owner.id);
    assert.deepEqual(new Set(pinged.map(row => row.userId)), audience, 'exactly the readers, never the author');
    return { count: sent.count, pinged: pinged.length };
  };
  await join(30);
  const few = await mention();
  await join(150);
  const many = await mention();
  assert.equal(many.pinged - few.pinged, 50);
  // One stored mention per extra reader; checking the members one by one cost about 8 statements each.
  assert.ok(many.count - few.count <= 50 + 5, `150 more members cost ${many.count - few.count} more statements`);
});

test('a message sent over the WebSocket resolves its channel access once there, not three times (S-WS-5)', async t => {
  const f = await setup(t);
  const channelReads = (sql: string[]) => sql.filter(statement => /FROM channels WHERE id = \?$/.test(statement)).length;
  const overSocket = await f.counter.measure(async () => {
    const sent = await f.owner.peer.request(MessageType.CHAT_SEND, { channelId: f.textId, content: 'over the socket' });
    assert.equal(sent.type, MessageType.CHAT_MESSAGE);
    // Queued behind the send, so its broadcast is over as well.
    await f.owner.peer.request(MessageType.COMMANDS_LIST);
  });
  const direct = await f.counter.measure(() => f.chatService.sendMessage(f.owner.id, f.textId, 'straight to the service'));
  assert.ok(direct.result.success);
  assert.equal(channelReads(overSocket.sql) - channelReads(direct.sql), 2,
    'the socket reads the channel once to authorize the message and once to find who receives it');
});

test('a person joining a voice room has access to it resolved once, not twice in a row (S-WS-5)', async t => {
  const f = await setup(t);
  const checks = t.mock.method(f.channelService, 'canUserAccessChannel');
  const answer = await f.owner.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  assert.equal(answer.type, MessageType.VOICE_USER_JOINED);
  // Queued behind the join, so whatever it awaited is over as well.
  await f.owner.peer.request(MessageType.COMMANDS_LIST);
  // Whether they may speak there is a question of its own (resolvePermissionMuted), asked with SPEAK.
  const access = checks.mock.calls.filter(call => call.arguments[1] === f.voiceId && call.arguments[2] === undefined);
  assert.equal(access.length, 1);
});

test('searching reads access once, however many channels and forum topics the server has', async t => {
  const f = await setup(t);
  const viewer = await f.member('Search viewer');
  for (let index = 0; index < 3; index++) {
    await f.messageRepo.create({ id: randomUUID(), channelId: f.textId, userId: f.owner.id, content: `needle ${index}`, createdAt: 1_000 + index, isSystem: false });
  }
  const search = () => f.counter.measure(() => f.searchService.search(viewer, { query: 'needle' }));
  const few = await search();
  assert.equal(few.result.messages.length, 3);
  const forum = await f.channel({ name: 'big-forum', type: 'FORUM' });
  for (let index = 0; index < 40; index++) f.topic(forum, `Topic ${index}`);
  const many = await search();
  assert.equal(many.result.messages.length, 3);
  // Each channel used to cost two checks of about 11 statements.
  assert.equal(many.count, few.count, 'forty more channels cost no extra statements');
});

test('a community snapshot reads each member and channel once', async t => {
  const f = await setup(t);
  const viewer = await f.member('Community viewer');
  await f.communityService.updateSettings(f.owner.id, { eventsEnabled: true });
  const now = Date.now();
  const event = (index: number) => f.communityService.saveEvent(f.owner.id, {
    title: `Event ${index}`, description: '', location: { kind: 'voice', channelId: f.voiceId },
    startsAt: now + 60_000, endsAt: now + 120_000, repeat: 'none', timeZone: 'UTC',
    audience: index % 2 ? { visibility: 'private', userIds: [viewer], roleIds: [] } : undefined,
  }, now);
  for (let index = 0; index < 5; index++) await event(index);
  // What the snapshot reads beyond each event's own rows: its access and the other lists.
  const accessReads = async () => {
    const snapshot = await f.counter.measure(() => f.communityService.snapshot(viewer));
    const rows = await f.counter.measure(async () => {
      for (const entry of f.communityService.repository.events()) f.communityService.repository.interest(entry.id, viewer);
    });
    return { events: snapshot.result.events.length, count: snapshot.count - rows.count };
  };
  const first = await accessReads();
  assert.equal(first.events, 5);
  for (let index = 5; index < 10; index++) await event(index);
  const second = await accessReads();
  assert.equal(second.events, 10);
  // Each event used to check its audience and room again, about 18 statements apiece.
  assert.equal(second.count, first.count, 'five more events add no access reads');
  assert.ok(first.count <= 15, `the snapshot's access took ${first.count} statements`);
});

test('bot grants live in memory, written through and dropped with their bot', async t => {
  const f = await setup(t);
  const human = await f.member('Not a bot');
  const botId = await f.bot(['commands', 'read_messages']);
  const reads = await f.counter.measure(async () => [
    f.botPermissions.getChannelPermissions(human), f.botPermissions.allows(botId, 'commands'),
    f.botPermissions.allows(botId, 'send_messages'), f.botPermissions.get(botId),
  ]);
  assert.equal(reads.count, 0, 'people and bots are told apart without reading the database');
  assert.deepEqual(reads.result.slice(0, 3), [undefined, true, false]);
  const state = f.botPermissions.get(botId);
  assert.ok(state && Object.isFrozen(state) && Object.isFrozen(state.granted));
  const { permissions } = f.botPermissions.declare(botId, ['commands', 'read_messages', 'send_messages']);
  assert.equal(f.botPermissions.allows(botId, 'send_messages'), false, 'a new request is not a grant');
  f.botPermissions.approve(f.owner.id, { botId, expectedRevision: permissions.revision, granted: ['send_messages'] });
  assert.equal(f.botPermissions.allows(botId, 'send_messages'), true);
  assert.equal(f.botPermissions.allows(botId, 'commands'), false);
  const fresh = await f.botService.create(f.owner.id);
  assert.ok(fresh.success);
  assert.equal(f.botPermissions.get(fresh.bot.id)?.requested, null, 'a bot added later is known at once');
  assert.equal((await f.botService.revoke(botId)).success, true);
  assert.equal(f.botPermissions.get(botId), undefined);
  assert.equal(f.botPermissions.allows(botId, 'send_messages'), false);
  assert.equal(f.botPermissions.getChannelPermissions(botId), undefined);
});

/** A socket that never opens, so the handlers only exercise their own logic. */
function session(userId: string, isBot = false): BotInteractionSession {
  const ws: unknown = Reflect.construct(WebSocket, [null, undefined, { autoPong: true, closeTimeout: 0 }]);
  assert.ok(ws instanceof WebSocket);
  return {
    ws, isBot, botId: isBot ? userId : undefined, sessionId: `${userId}:device`,
    user: { id: userId, clientId: userId, nickname: userId, joinedAt: 0, status: 'ONLINE', isBot },
  };
}

test('miniapp updates reach the room once per member and an unchanged server sweeps nothing', async t => {
  const f = await setup(t);
  const botId = await f.bot(['miniapps', 'send_messages']);
  const humans: BotInteractionSession[] = [];
  for (let index = 0; index < 40; index++) humans.push(session(await f.member(`Online ${index}`)));
  const bot = session(botId, true);
  const current = new Set([...humans, bot]);
  const room = new Map(humans.slice(0, 8).map(entry => [entry.sessionId!, f.voiceId]));
  const sent: Array<{ session: BotInteractionSession; message: ProtocolMessage }> = [];
  let version = 0;
  const handler = new BotScreenHandler(new BotScreenService(), f.channelService, f.userService, {
    sessions: () => current,
    isCurrent: entry => current.has(entry),
    accessVersion: () => version,
    getVoiceChannelId: sessionId => room.get(sessionId) ?? null,
    send: (entry, message) => { sent.push({ session: entry, message }); },
    authorizeInvocation: async () => ({ creatorUserId: humans[0].user!.id, originChannelId: f.textId, isCurrent: () => true }),
    endInvocation: () => {},
  });
  t.after(() => handler.close());
  await handler.handle(bot, MessageType.BOT_SCREEN_CREATE, {
    id: 'game', channelId: f.voiceId, title: 'Game', html: '<p>Game</p>', state: { turn: 0 }, invocationId: 'invocation',
  }, 'create');
  const snapshots = () => sent.filter(({ message }) => message.type === MessageType.BOT_SCREEN_SNAPSHOT).map(({ session }) => session);
  assert.deepEqual(new Set(snapshots()), new Set([bot, ...humans.slice(0, 8)]), 'only the bot and the room see the screen');
  const update = async (turn: number) => {
    const entry = handler['screens'].get('game');
    assert.ok(entry);
    sent.length = 0;
    return f.counter.measure(() => handler.handle(bot, MessageType.BOT_SCREEN_UPDATE, {
      id: 'game', instanceId: entry.screen.instanceId, state: { turn }, expectedRevision: entry.screen.revision,
    }, `update-${turn}`));
  };
  const updated = await update(1);
  assert.equal(snapshots().length, 10, 'the reply, the bot and the eight people in the room');
  // About 1,060 statements when every online session was checked, twice.
  assert.ok(updated.count <= 60, `an update took ${updated.count} statements`);
  const idle = await f.counter.measure(() => handler['enqueue'](() => handler['sweep']()));
  assert.equal(idle.count, 0, 'the periodic sweep reads nothing while access is unchanged');
  room.delete(humans[1].sessionId!);
  version++;
  await handler.revokeInvalid();
  assert.ok(sent.some(({ session, message }) => session === humans[1] && message.type === MessageType.BOT_SCREEN_REMOVED));
  sent.length = 0;
  await update(2);
  assert.equal(snapshots().includes(humans[1]), false, 'who left the room stops receiving the screen');
});

test('a selector vote notifies the channel reading each member once', async t => {
  const f = await setup(t);
  const botId = await f.bot(['selectors', 'send_messages', 'read_messages']);
  const channel = await f.channel({ name: 'votes', type: 'TEXT', botCommandsEnabled: true });
  const humans: BotInteractionSession[] = [];
  for (let index = 0; index < 40; index++) humans.push(session(await f.member(`Voter ${index}`)));
  const bot = session(botId, true);
  const current = new Set([...humans, bot]);
  const selectors = new BotSelectorService(new SqliteBotSelectorRepository(f.db));
  const sent: Array<{ session: BotInteractionSession; message: ProtocolMessage }> = [];
  const handler = new BotSelectorHandler(selectors, f.channelService, f.userService, {
    sessions: () => current,
    isCurrent: entry => current.has(entry),
    allowsBot: () => true,
    accessVersion: () => 0,
    send: (entry, message) => { sent.push({ session: entry, message }); },
    authorizeInvocation: async () => undefined,
    publish: async () => { throw new Error('Not published in this test.'); },
    broadcastMessage: async () => {},
  });
  t.after(() => handler.close());
  const selector = selectors.create(botId, {
    channelId: channel.id, title: 'Vote', choices: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
    presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 1000,
  });
  selectors.markPublished(selector.id, botId);
  const vote = await f.counter.measure(() => handler.handle(humans[0], MessageType.SELECTOR_RESPOND, { id: selector.id, value: 'a' }, 'vote'));
  const notified = new Set(sent.filter(({ message }) => message.type === MessageType.SELECTOR_SNAPSHOT).map(({ session }) => session));
  assert.equal(notified.size, 41, 'every member who can read the channel, and its bot');
  // About 1,500 statements when each session was checked twice.
  assert.ok(vote.count <= 200, `a vote took ${vote.count} statements`);
});

test('a selector vote under constant access changes gives up instead of checking forever (BOTS-8)', async t => {
  const f = await setup(t);
  const botId = await f.bot(['selectors', 'send_messages', 'read_messages']);
  const channel = await f.channel({ name: 'churn', type: 'TEXT', botCommandsEnabled: true });
  const voter = session(await f.member('Churn voter'));
  const current = new Set([voter, session(botId, true)]);
  const selectors = new BotSelectorService(new SqliteBotSelectorRepository(f.db));
  const sent: ProtocolMessage[] = [];
  let version = 0;
  let checks = 0;
  const handler = new BotSelectorHandler(selectors, f.channelService, f.userService, {
    sessions: () => current,
    isCurrent: entry => current.has(entry),
    allowsBot: () => true,
    // Every read sees a new version, as when channels or roles keep changing during the check.
    accessVersion: () => version++,
    send: (_entry, message) => { sent.push(message); },
    authorizeInvocation: async () => undefined,
    publish: async () => { throw new Error('Not published in this test.'); },
    broadcastMessage: async () => {},
  });
  t.after(() => handler.close());
  const contexts = f.channelService.getAccessContext.bind(f.channelService);
  t.mock.method(f.channelService, 'getAccessContext', (userId: string, channelId?: string) => {
    if (userId === voter.user!.id) checks++;
    return contexts(userId, channelId);
  });
  const selector = selectors.create(botId, {
    channelId: channel.id, title: 'Churn', choices: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
    presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 10,
  });
  selectors.markPublished(selector.id, botId);
  const busy = { code: ProtocolErrorCode.BOT_COMMAND_BUSY, message: 'Permissions are changing. Retry shortly.' };

  await handler.handle(voter, MessageType.SELECTOR_RESPOND, { id: selector.id, value: 'a' }, 'churn');
  assert.deepEqual(sent.find(message => message.requestId === 'churn')?.payload, busy);
  assert.ok(checks > 0 && checks <= 8, `the vote was checked ${checks} times`);
  assert.deepEqual(selectors.get(selector.id)?.responses, {}, 'no vote is recorded on access that never held still');

  // A role write under way blocks the answer the same way, as it does for miniapps.
  t.mock.method(f.channelService, 'getRoleAccessVersion', () => null);
  await handler.handle(voter, MessageType.SELECTOR_RESPOND, { id: selector.id, value: 'a' }, 'pending-role');
  assert.deepEqual(sent.find(message => message.requestId === 'pending-role')?.payload, busy);
  assert.deepEqual(selectors.get(selector.id)?.responses, {});
});

/** A bot that announced its profile, so the settings list shows it, holding a storage grant older clients cannot parse. */
async function profiledBot(f: Awaited<ReturnType<typeof setup>>, name: string) {
  const botId = await f.bot(['commands', 'server_storage']);
  assert.equal((await f.botService.updateProfile(botId, { name })).success, true);
  return botId;
}

test('a bot settings broadcast reads the bots once and builds each kind of message once (BOTS-5)', async t => {
  const f = await setup(t);
  await f.serverRepo.updateServer({ maxUsers: LIMITS.MAX_USERS_UNLIMITED });
  const botId = await profiledBot(f, 'Settings bot');
  await profiledBot(f, 'Other bot');
  const configurers = await f.role('Bot configurers', Permission.CONFIGURE_BOTS);
  const offer = createProtocolOffer('client');
  const older = { ...offer, features: offer.features.filter(feature => feature !== 'bot-storage' && feature !== 'bot-manifest-url') };
  // The owner manages bots; the others alternate between configuring or not, on current and older clients.
  const people = [{ peer: f.owner.peer, configures: true }];
  const join = async (count: number) => {
    for (let index = 0; index < count; index++) {
      const order = people.length;
      const person = await f.human(`Reader ${order}`, undefined, undefined, false, PROTOCOL_VERSION, order % 3 === 0 ? older : offer);
      if (order % 2 === 0) await f.roleRepo.assignRole(person.id, configurers);
      people.push({ peer: person.peer, configures: order % 2 === 0 });
    }
    await Promise.all(people.map(({ peer }) => peer.barrier()));
  };
  const broadcast = async () => {
    const since = people.map(({ peer }) => peer.messages.length);
    const measured = await f.counter.measure(() => f.wsServer['botManagement'].broadcastSettings(botId));
    await Promise.all(people.map(({ peer }) => peer.barrier()));
    const received = people.map(({ peer }, index) => peer.messages.slice(since[index]).filter(message =>
      message.type === MessageType.BOT_SETTINGS_LIST_RESPONSE || message.type === MessageType.BOT_SETTINGS_SNAPSHOT));
    const reads = (pattern: RegExp) => measured.sql.filter(sql => pattern.test(sql)).length;
    return { received, count: measured.count, bots: reads(/FROM bots ORDER BY/), settings: reads(/\bbot_settings\b/) };
  };

  await join(6);
  const few = await broadcast();
  await join(6);
  const many = await broadcast();
  for (const [index, { peer, configures }] of people.entries()) {
    const [list, snapshot, ...rest] = many.received[index];
    assert.equal(rest.length, 0, `reader ${index} gets one list and at most one snapshot`);
    // Each reader gets exactly what asking for it returns, though readers of the same kind share one message.
    assert.equal(list?.type, MessageType.BOT_SETTINGS_LIST_RESPONSE);
    assert.deepEqual(list.payload, (await peer.request(MessageType.BOT_SETTINGS_LIST, {})).payload, `reader ${index} list`);
    if (!configures) {
      assert.equal(snapshot, undefined, `reader ${index} may not see the changed bot's settings`);
      continue;
    }
    assert.equal(snapshot?.type, MessageType.BOT_SETTINGS_SNAPSHOT);
    assert.deepEqual(snapshot.payload, (await peer.request(MessageType.BOT_SETTINGS_GET, { botId })).payload, `reader ${index} snapshot`);
  }
  assert.ok(many.bots <= 2 && many.bots === few.bots, `the bots and their manifest URLs were listed ${many.bots} times`);
  assert.equal(many.settings, few.settings, 'settings are read once per kind of reader, not once per reader');
  // About 14 statements for each reader, and the bots listed 31 times for 13 readers, when every connection
  // read the bots and checked its permissions twice.
  const perReader = (many.count - few.count) / 6;
  assert.ok(perReader <= 6, `each extra reader took ${perReader} statements`);
});

test('bot settings broadcasts arrive in the order of the changes, even when one is slow (BOTS-5)', async t => {
  const f = await setup(t);
  const botId = await profiledBot(f, 'Before');
  const reader = await f.human('Slow reader');
  await reader.peer.barrier();
  const check = f.permissions.checkPermission.bind(f.permissions);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  let hold = true;
  t.mock.method(f.permissions, 'checkPermission', async (userId: string, permission: Permission) => {
    const allowed = await check(userId, permission);
    if (userId === reader.id && permission === Permission.CONFIGURE_BOTS && hold) {
      hold = false;
      entered();
      await held;
    }
    return allowed;
  });
  const since = reader.peer.messages.length;
  const first = f.wsServer['botManagement'].broadcastSettings();
  await holding;
  assert.equal((await f.botService.updateProfile(botId, { name: 'After' })).success, true);
  const second = f.wsServer['botManagement'].broadcastSettings(botId);
  // Reading and sending involve no I/O: a broadcast that did not wait for the first one would be done by now.
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await Promise.all([first, second]);
  await reader.peer.barrier();
  const names = reader.peer.messages.slice(since).filter(message => message.type === MessageType.BOT_SETTINGS_LIST_RESPONSE)
    .map(message => botSettingsListResponseSchema.parse(message.payload).bots.find(bot => bot.botId === botId)?.name);
  assert.deepEqual(names, ['Before', 'After'], 'the list read before the change never lands after the newer one');
});

test('the deleted-message sweep finds its rows through an index, not by reading every message', async t => {
  const f = await setup(t);
  for (let index = 0; index < 50; index++) {
    await f.messageRepo.create({ id: randomUUID(), channelId: f.textId, userId: f.owner.id, content: `kept ${index}`, createdAt: index + 1, isSystem: false });
  }
  const deleted = randomUUID();
  await f.messageRepo.create({ id: deleted, channelId: f.textId, userId: f.owner.id, content: 'gone', createdAt: 100, isSystem: false });
  await f.messageRepo.markDeleted(deleted, 200, f.owner.id, 300);
  const sweep = await f.counter.measure(() => f.chatService.expireDeletedMessages());
  assert.equal((await f.messageRepo.findById(deleted))?.deleteUndoUntil, null, 'the undo window ended');
  const onMessages = [...new Set(sweep.sql.filter(sql => /\bmessages\b/.test(sql) && /delete_undo_until/.test(sql)))];
  assert.ok(onMessages.length >= 2, 'the sweep lists and closes the expired rows');
  for (const sql of onMessages) {
    const plan = JSON.stringify(f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from(sql.matchAll(/\?/g), () => Date.now())));
    assert.match(plan, /idx_messages_delete_undo/, sql);
    assert.doesNotMatch(plan, /SCAN messages/, sql);
  }
});
