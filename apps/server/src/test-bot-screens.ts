import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import {
  BOT_SCREEN_LIMITS, MessageType, Permission, ProtocolErrorCode, botScreenActionEventSchema,
  botScreenListResultSchema, botScreenSchema, type ChannelSummary, type ProtocolMessage,
} from '@monky/shared';
import { BotScreenService } from './application/services/BotScreenService';
import { BotScreenHandler } from './infrastructure/websocket/BotScreenHandler';
import type { BotInteractionSession } from './infrastructure/websocket/BotInteractionHandler';

function fixture() {
  const current = new Set<BotInteractionSession>();
  const messages: Array<{ session: BotInteractionSession; message: ProtocolMessage }> = [];
  const members = new Set(['alice', 'bob', 'spectator']);
  const permissions = new Map<string, number>();
  const roles = new Map<string, string[]>();
  const voiceChannels = new Map<string, string>();
  const defaults = Permission.READ_MESSAGES | Permission.SEND_MESSAGES | Permission.USE_BOT_COMMANDS;
  let enabled = true;
  let exists = true;
  let version = 0;
  let invocationAlive = true;
  let accessHook: (() => void) | undefined;
  const channel: ChannelSummary = {
    id: 'voice', name: 'Voice', type: 'VOICE', position: 0, isPrivate: false, allowedRoleIds: [],
    serverId: 'server', createdAt: 0, botCommandsEnabled: false,
  };
  const session = (id: string, isBot = false, device = 'session'): BotInteractionSession => {
    const ws: unknown = Reflect.construct(WebSocket, [null, undefined, { autoPong: true, closeTimeout: 0 }]);
    assert.ok(ws instanceof WebSocket);
    const result: BotInteractionSession = {
      ws, isBot, botId: isBot ? id : undefined, sessionId: `${id}:${device}`,
      user: { id, clientId: id, nickname: id, joinedAt: 0, status: 'ONLINE', isBot },
    };
    current.add(result);
    return result;
  };
  const bot = session('bot', true);
  const otherBot = session('other-bot', true);
  const alice = session('alice');
  const bob = session('bob');
  const spectator = session('spectator');
  const stranger = session('stranger');
  for (const entry of [alice, bob, spectator]) voiceChannels.set(entry.sessionId!, 'voice');
  permissions.set('spectator', Permission.READ_MESSAGES);
  const service = new BotScreenService();
  const handler = new BotScreenHandler(service, {
    getChannelSummary: async (id) => id === 'voice' && exists ? { ...channel } : null,
    getAccessContext: async (id) => {
      const result = { permissions: permissions.get(id) ?? defaults, roleIds: roles.get(id) ?? [] };
      accessHook?.();
      return result;
    },
  }, { isMember: async (id) => members.has(id) }, {
    sessions: () => current,
    isCurrent: (entry) => current.has(entry),
    accessVersion: () => version,
    getVoiceChannelId: (id) => voiceChannels.get(id) ?? null,
    send: (entry, message) => { messages.push({ session: entry, message }); },
    authorizeInvocation: async (owner, invocationId, channelId) =>
      owner === bot && invocationId === 'invocation' && channelId === 'voice' && invocationAlive &&
        enabled && voiceChannels.get(alice.sessionId!) === channelId
        ? { creatorUserId: 'alice', originChannelId: 'chat',
            isCurrent: () => invocationAlive && enabled && voiceChannels.get(alice.sessionId!) === channelId } : undefined,
  });
  let request = 0;
  const call = async (entry: BotInteractionSession, type: MessageType, payload: unknown) => {
    const requestId = `request-${request++}`;
    await handler.handle(entry, type, payload, requestId);
    const found = messages.find(({ session, message }) => session === entry && message.requestId === requestId);
    assert.ok(found, `missing response to ${type}`);
    return found.message;
  };
  const create = (id = 'game', invocationId: string | undefined = 'invocation') => call(bot, MessageType.BOT_SCREEN_CREATE, {
    id, channelId: 'voice', title: 'Game', html: '<h1>Game</h1>', state: { turn: 'alice' }, invocationId,
  });
  return {
    service, handler, bot, otherBot, alice, bob, spectator, stranger, session, current, messages, call, create, permissions, channel,
    finishInvocation: () => { invocationAlive = false; },
    disable: () => { enabled = false; version++; },
    deleteChannel: () => { exists = false; version++; },
    revoke: (id: string) => { permissions.set(id, 0); version++; },
    join: (entry: BotInteractionSession, room = 'voice') => { voiceChannels.set(entry.sessionId!, room); version++; },
    leave: (entry: BotInteractionSession) => { voiceChannels.delete(entry.sessionId!); version++; },
    race: (hook: () => void) => { accessHook = () => { accessHook = undefined; hook(); }; },
    privatize: () => { channel.isPrivate = true; channel.allowedRoleIds = ['private']; roles.set('alice', ['private']); version++; },
  };
}

test('screen actions are human-authenticated, independent of command lifetime, and recoverable by spectators/reconnects', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  const initial = botScreenSchema.parse((await f.create()).payload);
  assert.equal(initial.revision, 0);
  assert.equal(initial.channelId, 'voice');
  assert.equal(f.messages.some(({ session, message }) => session === f.stranger && message.type === MessageType.BOT_SCREEN_SNAPSHOT), false);
  assert.equal(f.messages.some(({ session, message }) => session === f.otherBot && message.type === MessageType.BOT_SCREEN_SNAPSHOT), false);
  assert.equal('creatorUserId' in initial, false);
  f.finishInvocation();
  const action = { id: 'game', action: 'move', payload: { to: 1 }, revision: 0, actionId: 'move-1' };
  assert.equal((await f.call(f.bot, MessageType.BOT_SCREEN_ACTION, action)).type, MessageType.SERVER_ERROR);
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, { ...action, userId: 'alice' })).type, MessageType.SERVER_ERROR);
  assert.equal((await f.call(f.spectator, MessageType.BOT_SCREEN_ACTION, action)).type, MessageType.SERVER_ERROR);
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, action)).type, MessageType.BOT_SCREEN_SNAPSHOT);
  const event = f.messages.find(({ message }) => message.type === MessageType.BOT_SCREEN_ACTION_EVENT);
  assert.ok(event);
  assert.equal(event.session, f.bot);
  assert.equal(botScreenActionEventSchema.parse(event.message.payload).userId, 'bob');
  await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, action);
  assert.equal(f.messages.filter(({ message }) => message.type === MessageType.BOT_SCREEN_ACTION_EVENT).length, 1);
  await f.handler.disconnect(f.bob);
  f.current.delete(f.bob);
  f.leave(f.bob);
  assert.ok(f.service.get('game'));
  const bobReconnect = f.session('bob');
  assert.equal((await f.call(bobReconnect, MessageType.BOT_SCREEN_LIST, { channelId: 'voice' })).type, MessageType.SERVER_ERROR);
  f.join(bobReconnect);
  const result = botScreenListResultSchema.parse((await f.call(bobReconnect, MessageType.BOT_SCREEN_LIST, { channelId: 'voice' })).payload);
  assert.equal(result.screens[0]?.id, 'game');
  assert.equal(botScreenListResultSchema.parse((await f.call(f.spectator, MessageType.BOT_SCREEN_LIST, { channelId: 'voice' })).payload).screens.length, 1);
});

test('ownership, revisions, creation proof and capability revocation cannot be bypassed', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  await f.create();
  const update = { id: 'game', state: { turn: 'bob' }, expectedRevision: 0 };
  assert.equal((await f.call(f.otherBot, MessageType.BOT_SCREEN_UPDATE, update)).type, MessageType.SERVER_ERROR);
  assert.equal((await f.call(f.alice, MessageType.BOT_SCREEN_CREATE, { channelId: 'voice', title: 'Fake', html: 'Fake', state: {} })).type, MessageType.SERVER_ERROR);
  const changed = botScreenSchema.parse((await f.call(f.bot, MessageType.BOT_SCREEN_UPDATE, update)).payload);
  assert.equal(changed.revision, 1);
  const staleAction = await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, {
    id: 'game', action: 'move', payload: { to: 2 }, revision: 0, actionId: 'stale-ui',
  });
  assert.equal(staleAction.type, MessageType.SERVER_ERROR);
  assert.equal(f.messages.filter(({ message }) => message.type === MessageType.BOT_SCREEN_ACTION_EVENT).length, 0);
  const stale = await f.call(f.bot, MessageType.BOT_SCREEN_UPDATE, update);
  assert.equal(stale.type, MessageType.SERVER_ERROR);
  assert.deepEqual(stale.payload, { code: ProtocolErrorCode.BOT_SCREEN_CONFLICT, message: 'Screen revision is stale. Reload the current snapshot.' });
  assert.equal((await f.create('forged', 'wrong-invocation')).type, MessageType.SERVER_ERROR);
  f.revoke('bob');
  await f.handler.revokeInvalid();
  assert.ok(f.service.get('game'));
  assert.equal(botScreenListResultSchema.parse((await f.call(f.bob, MessageType.BOT_SCREEN_LIST, { channelId: 'voice' })).payload).screens.length, 1);
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, {
    id: 'game', action: 'move', payload: null, revision: 1, actionId: 'revoked-control',
  })).type, MessageType.SERVER_ERROR);
  f.leave(f.bob);
  await f.handler.revokeInvalid();
  assert.ok(f.messages.some(({ session, message }) => session === f.bob && message.type === MessageType.BOT_SCREEN_REMOVED));
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_LIST, { channelId: 'voice' })).type, MessageType.SERVER_ERROR);
  f.revoke('alice');
  await f.handler.revokeInvalid();
  assert.equal(f.service.get('game'), undefined);
});

test('access changes during asynchronous authorization cannot publish private screens', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  f.race(() => f.revoke('alice'));
  assert.equal((await f.create()).type, MessageType.SERVER_ERROR);
  assert.equal(f.service.list().length, 0);
  assert.equal(f.messages.some(({ message }) => message.type === MessageType.BOT_SCREEN_SNAPSHOT), false);
});

test('invocation-scoped private screens never leak to outsiders or other bots', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  f.privatize();
  assert.equal((await f.create()).type, MessageType.BOT_SCREEN_SNAPSHOT);
  const recipients = f.messages.filter(({ message }) => message.type === MessageType.BOT_SCREEN_SNAPSHOT).map(({ session }) => session);
  assert.ok(recipients.every((session) => session === f.bot || session === f.alice));
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_LIST, { channelId: 'voice' })).type, MessageType.SERVER_ERROR);
  assert.equal((await f.call(f.bot, MessageType.BOT_SCREEN_CREATE, {
    id: 'no-proof', channelId: 'voice', title: 'Private', html: 'No proof', state: {},
  })).type, MessageType.SERVER_ERROR);
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, {
    id: 'game', action: 'move', payload: null, revision: 0, actionId: 'hidden',
  })).type, MessageType.SERVER_ERROR);
  await f.call(f.bot, MessageType.BOT_SCREEN_CLOSE, { id: 'game' });
  assert.equal(f.messages.some(({ session, message }) => session === f.bob && message.type === MessageType.BOT_SCREEN_REMOVED), false);
});

test('channel deletion, global command revocation and bot disconnect end screens', async (t) => {
  for (const end of ['delete', 'revoke', 'disconnect'] as const) {
    const f = fixture(); t.after(() => f.handler.close());
    await f.create();
    if (end === 'delete') f.deleteChannel();
    if (end === 'revoke') f.revoke('alice');
    if (end === 'disconnect') { f.current.delete(f.bot); await f.handler.disconnect(f.bot); }
    else await f.handler.revokeInvalid();
    assert.equal(f.service.list().length, 0);
    assert.ok(f.messages.some(({ session, message }) => session === f.alice && message.type === MessageType.BOT_SCREEN_REMOVED));
  }
});

test('miniapps require a voice room and its exact device, not text visibility or another logged-in device', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  const secondDevice = f.session('alice', false, 'other-device');
  const otherRoom = f.session('bob', false, 'other-room-device');
  f.join(otherRoom, 'other-voice');
  await f.create();
  for (const entry of [secondDevice, otherRoom, f.stranger]) {
    assert.equal(f.messages.some(({ session, message }) => session === entry && message.type === MessageType.BOT_SCREEN_SNAPSHOT), false);
    assert.equal((await f.call(entry, MessageType.BOT_SCREEN_LIST, { channelId: 'voice' })).type, MessageType.SERVER_ERROR);
    assert.equal((await f.call(entry, MessageType.BOT_SCREEN_ACTION, {
      id: 'game', action: 'move', payload: null, revision: 0, actionId: 'outside',
    })).type, MessageType.SERVER_ERROR);
  }
  f.join(secondDevice);
  assert.equal(botScreenListResultSchema.parse((await f.call(secondDevice, MessageType.BOT_SCREEN_LIST, { channelId: 'voice' })).payload).screens.length, 1);
  f.channel.type = 'TEXT';
  assert.equal((await f.create('text-screen')).type, MessageType.SERVER_ERROR);
});

test('leaving or moving revokes viewers without deleting the shared game or changing its state', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  await f.create();
  f.finishInvocation();
  f.disable();
  f.leave(f.alice);
  f.join(f.bob, 'other-voice');
  f.leave(f.spectator);
  await f.handler.revokeInvalid();
  assert.deepEqual(f.service.get('game')?.screen.state, { turn: 'alice' });
  for (const entry of [f.alice, f.bob, f.spectator]) {
    assert.ok(f.messages.some(({ session, message }) => session === entry && message.type === MessageType.BOT_SCREEN_REMOVED));
  }
  f.join(f.alice);
  const result = botScreenListResultSchema.parse((await f.call(f.alice, MessageType.BOT_SCREEN_LIST, { channelId: 'voice' })).payload);
  assert.equal(result.screens[0]?.id, 'game');
  assert.equal(result.screens[0]?.revision, 0);
});

test('voice changes during asynchronous creation or action checks never publish unauthorized work', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  f.race(() => f.leave(f.alice));
  assert.equal((await f.create()).type, MessageType.SERVER_ERROR);
  assert.equal(f.service.list().length, 0);
  f.join(f.alice);
  await f.create();
  f.race(() => f.join(f.bob, 'other-voice'));
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, {
    id: 'game', action: 'move', payload: null, revision: 0, actionId: 'moved',
  })).type, MessageType.SERVER_ERROR);
  assert.equal(f.messages.some(({ message }) => message.type === MessageType.BOT_SCREEN_ACTION_EVENT), false);
});

test('active screen counts and action rates are bounded', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  for (let index = 0; index < BOT_SCREEN_LIMITS.activePerChannel; index++) assert.equal((await f.create(`game-${index}`)).type, MessageType.BOT_SCREEN_SNAPSHOT);
  assert.equal((await f.create('overflow')).type, MessageType.SERVER_ERROR);
  for (let index = 0; index < BOT_SCREEN_LIMITS.actionsPerSecond; index++) {
    await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, { id: 'game-0', action: 'move', payload: null, revision: 0, actionId: `action-${index}` });
  }
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, { id: 'game-0', action: 'move', payload: null, revision: 0, actionId: 'overflow' })).type, MessageType.SERVER_ERROR);
  assert.equal(f.messages.filter(({ message }) => message.type === MessageType.BOT_SCREEN_ACTION_EVENT).length, BOT_SCREEN_LIMITS.actionsPerSecond);
});

test('service enforces per-bot and whole-server bounds and frees capacity on close', () => {
  const service = new BotScreenService();
  const create = (bot: string, index: number) => service.create(bot, {
    id: `${bot}-${index}`, channelId: `${bot}-channel-${index}`, title: 'Game', html: '<p>Game</p>', state: null,
  });
  for (let index = 0; index < BOT_SCREEN_LIMITS.activePerBot; index++) create('bot-0', index);
  assert.throws(() => create('bot-0', 100));
  for (let bot = 1; bot < BOT_SCREEN_LIMITS.activePerServer / BOT_SCREEN_LIMITS.activePerBot; bot++) {
    for (let index = 0; index < BOT_SCREEN_LIMITS.activePerBot; index++) create(`bot-${bot}`, index);
  }
  assert.equal(service.list().length, BOT_SCREEN_LIMITS.activePerServer);
  assert.throws(() => create('extra', 0));
  service.remove('bot-0-0', 'bot-0');
  create('extra', 0);
  assert.equal(service.list().length, BOT_SCREEN_LIMITS.activePerServer);
  service.clear();
  assert.equal(service.list().length, 0);
});
