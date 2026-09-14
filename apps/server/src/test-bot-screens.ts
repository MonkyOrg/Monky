import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import {
  BOT_SCREEN_LIMITS, MessageType, Permission, ProtocolErrorCode, botScreenActionEventSchema,
  botScreenListResultSchema, botScreenSchema, botScreenRemovedSchema, type ChannelSummary, type ProtocolMessage,
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
  let roleVersion: number | null = 0;
  let invocationAlive = true;
  const invocations = new Set(['invocation']);
  const endedInvocations = new Set<string>();
  let accessHook: ((id: string) => void) | undefined;
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
    getRoleAccessVersion: () => roleVersion,
    getChannelSummary: async (id) => id === 'voice' && exists ? { ...channel } : null,
    getAccessContext: async (id) => {
      const result = { permissions: permissions.get(id) ?? defaults, roleIds: roles.get(id) ?? [] };
      accessHook?.(id);
      return result;
    },
  }, { isMember: async (id) => members.has(id) }, {
    sessions: () => current,
    isCurrent: (entry) => current.has(entry),
    accessVersion: () => version,
    getVoiceChannelId: (id) => voiceChannels.get(id) ?? null,
    send: (entry, message) => { messages.push({ session: entry, message }); },
    authorizeInvocation: async (owner, invocationId, channelId) =>
      owner === bot && invocations.has(invocationId) && !endedInvocations.has(invocationId) && channelId === 'voice' && invocationAlive &&
        enabled && voiceChannels.get(alice.sessionId!) === channelId
        ? { creatorUserId: 'alice', originChannelId: 'chat',
            isCurrent: () => invocationAlive && !endedInvocations.has(invocationId) && enabled && voiceChannels.get(alice.sessionId!) === channelId } : undefined,
    endInvocation: (owner, invocationId) => { if (owner === bot) endedInvocations.add(invocationId); },
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
  const ref = (id = 'game') => {
    const screen = service.get(id)?.screen;
    assert.ok(screen);
    return { id, instanceId: screen.instanceId };
  };
  return {
    service, handler, bot, otherBot, alice, bob, spectator, stranger, session, current, messages, call, create, ref, permissions, channel,
    startInvocation: (id: string) => { invocations.add(id); invocationAlive = true; },
    defaultPermissions: defaults,
    setRoleAccessVersion: (value: number | null) => { roleVersion = value; },
    setPermissions: (id: string, value: number) => { permissions.set(id, value); version++; },
    finishInvocation: () => { invocationAlive = false; },
    disable: () => { enabled = false; version++; },
    deleteChannel: () => { exists = false; version++; },
    revoke: (id: string) => { permissions.set(id, 0); version++; },
    join: (entry: BotInteractionSession, room = 'voice') => { voiceChannels.set(entry.sessionId!, room); version++; },
    leave: (entry: BotInteractionSession) => { voiceChannels.delete(entry.sessionId!); version++; },
    race: (hook: () => void, userId?: string, ready = () => true) => {
      accessHook = (id) => { if ((userId && id !== userId) || !ready()) return; accessHook = undefined; hook(); };
    },
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
  assert.equal(initial.creatorUserId, 'alice');
  f.finishInvocation();
  const action = { ...f.ref(), action: 'move', payload: { to: 1 }, revision: 0, actionId: 'move-1' };
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
  const update = { ...f.ref(), state: { turn: 'bob' }, expectedRevision: 0 };
  assert.equal((await f.call(f.otherBot, MessageType.BOT_SCREEN_UPDATE, update)).type, MessageType.SERVER_ERROR);
  assert.equal((await f.call(f.alice, MessageType.BOT_SCREEN_CREATE, { channelId: 'voice', title: 'Fake', html: 'Fake', state: {} })).type, MessageType.SERVER_ERROR);
  const changed = botScreenSchema.parse((await f.call(f.bot, MessageType.BOT_SCREEN_UPDATE, update)).payload);
  assert.equal(changed.revision, 1);
  const staleAction = await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, {
    ...f.ref(), action: 'move', payload: { to: 2 }, revision: 0, actionId: 'stale-ui',
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
    ...f.ref(), action: 'move', payload: null, revision: 1, actionId: 'revoked-control',
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
    ...f.ref(), action: 'move', payload: null, revision: 0, actionId: 'hidden',
  })).type, MessageType.SERVER_ERROR);
  await f.call(f.bot, MessageType.BOT_SCREEN_CLOSE, f.ref());
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
      ...f.ref(), action: 'move', payload: null, revision: 0, actionId: 'outside',
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
    ...f.ref(), action: 'move', payload: null, revision: 0, actionId: 'moved',
  })).type, MessageType.SERVER_ERROR);
  assert.equal(f.messages.some(({ message }) => message.type === MessageType.BOT_SCREEN_ACTION_EVENT), false);
});

test('active screen counts and action rates are bounded', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  for (let index = 0; index < BOT_SCREEN_LIMITS.activePerChannel; index++) assert.equal((await f.create(`game-${index}`)).type, MessageType.BOT_SCREEN_SNAPSHOT);
  assert.equal((await f.create('overflow')).type, MessageType.SERVER_ERROR);
  for (let index = 0; index < BOT_SCREEN_LIMITS.actionsPerSecond; index++) {
    await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, { ...f.ref('game-0'), action: 'move', payload: null, revision: 0, actionId: `action-${index}` });
  }
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, { ...f.ref('game-0'), action: 'move', payload: null, revision: 0, actionId: 'overflow' })).type, MessageType.SERVER_ERROR);
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
  service.remove(service.get('bot-0-0')!.screen, 'bot-0');
  create('extra', 0);
  assert.equal(service.list().length, BOT_SCREEN_LIMITS.activePerServer);
  service.clear();
  assert.equal(service.list().length, 0);
});

test('only the stable authenticated creator or an administrator can end a shared instance', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  await f.create();
  const ref = f.ref();
  for (const entry of [f.bob, f.spectator, f.bot, f.otherBot]) {
    const denied = await f.call(entry, MessageType.BOT_SCREEN_END, ref);
    assert.equal(denied.type, MessageType.SERVER_ERROR);
    assert.ok(f.service.get(ref.id));
  }
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_END, { ...ref, creatorUserId: 'bob' })).type, MessageType.SERVER_ERROR);
  f.finishInvocation();
  f.current.delete(f.alice);
  f.leave(f.alice);
  const rejoinedCreator = f.session('alice', false, 'rejoined-device');
  assert.equal((await f.call(rejoinedCreator, MessageType.BOT_SCREEN_END, ref)).type, MessageType.SERVER_ERROR);
  f.join(rejoinedCreator);
  const removed = botScreenRemovedSchema.parse((await f.call(rejoinedCreator, MessageType.BOT_SCREEN_END, ref)).payload);
  assert.equal(removed.reason, 'ended');
  assert.equal(removed.reason === 'ended' && removed.endedByUserId, 'alice');
  assert.equal(f.service.get(ref.id), undefined);
  for (const entry of [f.bot, f.bob, f.spectator]) {
    const events = f.messages.filter(({ session, message }) => session === entry && message.type === MessageType.BOT_SCREEN_REMOVED);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].message.payload, removed);
  }
  assert.equal(f.messages.some(({ session, message }) => session === f.otherBot && message.type === MessageType.BOT_SCREEN_REMOVED), false);
  assert.equal((await f.call(rejoinedCreator, MessageType.BOT_SCREEN_END, ref)).type, MessageType.SERVER_ERROR);
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, {
    ...ref, action: 'move', payload: null, revision: 0, actionId: 'after-end',
  })).type, MessageType.SERVER_ERROR);
});

test('raw bot screens have no accidental bot creator; MANAGE_SERVER alone is not administrator', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  const screen = botScreenSchema.parse((await f.call(f.bot, MessageType.BOT_SCREEN_CREATE, {
    id: 'raw', channelId: 'voice', title: 'Raw', html: 'Raw', state: null,
  })).payload);
  assert.equal(screen.creatorUserId, undefined);
  f.setPermissions('bob', Permission.MANAGE_SERVER);
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_END, f.ref('raw'))).type, MessageType.SERVER_ERROR);
  f.setPermissions('bob', Permission.ADMINISTRATOR);
  assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_END, f.ref('raw'))).type, MessageType.BOT_SCREEN_REMOVED);
  assert.equal(f.service.list().length, 0);
});

test('end revalidates permission and exact-room membership across authorization races', async (t) => {
  for (const mutation of ['role', 'room', 'disconnect'] as const) {
    const f = fixture(); t.after(() => f.handler.close());
    await f.create();
    f.setPermissions('bob', Permission.ADMINISTRATOR);
    f.race(() => {
      if (mutation === 'role') f.setPermissions('bob', Permission.MANAGE_SERVER);
      else if (mutation === 'room') f.join(f.bob, 'other-voice');
      else f.current.delete(f.bob);
    }, 'bob');
    if (mutation === 'disconnect') {
      await f.handler.handle(f.bob, MessageType.BOT_SCREEN_END, f.ref(), 'stale-end');
      assert.equal(f.messages.some(({ message }) => message.requestId === 'stale-end'), false);
    } else assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_END, f.ref())).type, MessageType.SERVER_ERROR);
    assert.ok(f.service.get('game'));
    assert.equal(f.messages.some(({ session, message }) => session === f.bot && message.type === MessageType.BOT_SCREEN_REMOVED), false);
  }
});

test('end serializes with updates and invalidates both stale instances and continuing creation', async (t) => {
  for (const endFirst of [true, false]) {
    const f = fixture(); t.after(() => f.handler.close());
    await f.create();
    const ref = f.ref();
    const update = () => f.call(f.bot, MessageType.BOT_SCREEN_UPDATE, { ...ref, state: { move: 1 }, expectedRevision: 0 });
    const end = () => f.call(f.alice, MessageType.BOT_SCREEN_END, ref);
    const [first, second] = await Promise.all(endFirst ? [end(), update()] : [update(), end()]);
    assert.equal(first.type, endFirst ? MessageType.BOT_SCREEN_REMOVED : MessageType.BOT_SCREEN_SNAPSHOT);
    assert.equal(second.type, endFirst ? MessageType.SERVER_ERROR : MessageType.BOT_SCREEN_REMOVED);
    assert.equal(f.service.list().length, 0);
    assert.equal((await f.create('resurrected')).type, MessageType.SERVER_ERROR);
    f.startInvocation('fresh-command');
    const replacement = botScreenSchema.parse((await f.create('game', 'fresh-command')).payload);
    assert.notEqual(replacement.instanceId, ref.instanceId);
    assert.equal((await f.call(f.alice, MessageType.BOT_SCREEN_END, ref)).type, MessageType.SERVER_ERROR);
    assert.equal((await f.call(f.bot, MessageType.BOT_SCREEN_CLOSE, ref)).type, MessageType.SERVER_ERROR);
    assert.equal((await update()).type, MessageType.SERVER_ERROR);
    assert.equal((await f.call(f.bob, MessageType.BOT_SCREEN_ACTION, {
      ...ref, action: 'move', payload: null, revision: 0, actionId: 'stale-frame',
    })).type, MessageType.SERVER_ERROR);
    assert.equal(f.service.get('game')?.screen.instanceId, replacement.instanceId);
    assert.equal(f.service.get('game')?.screen.revision, 0);
  }
});

test('screen service refuses forged provenance and old instance mutations after ID reuse', () => {
  const service = new BotScreenService();
  const input = { id: 'game', channelId: 'voice', title: 'Game', html: 'Game', state: null };
  assert.throws(() => service.create('bot', input, 'alice'), /verified invocation/);
  const first = service.create('bot', input).screen;
  service.remove(first, 'bot');
  const second = service.create('bot', input).screen;
  assert.notEqual(first.instanceId, second.instanceId);
  assert.throws(() => service.update(first, 'bot', { state: null, expectedRevision: 0 }), /instance not found/);
  assert.throws(() => service.remove(first, 'bot'), /instance not found/);
  assert.equal(service.get('game')?.screen, second);
});

test('screen authorization defers pending role writes without deleting active instances', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  await f.create();
  const ref = f.ref();
  f.setRoleAccessVersion(null);
  const denied = await f.call(f.alice, MessageType.BOT_SCREEN_END, ref);
  assert.equal(denied.type, MessageType.SERVER_ERROR);
  assert.deepEqual(denied.payload, { code: ProtocolErrorCode.BOT_COMMAND_BUSY, message: 'Permissions are changing. Retry shortly.' });
  await assert.rejects(f.handler.revokeInvalid(), /Permissions are changing/);
  assert.equal(f.service.get(ref.id)?.screen.instanceId, ref.instanceId);
  assert.equal(f.messages.some(({ message }) => message.type === MessageType.BOT_SCREEN_REMOVED), false);
  f.setRoleAccessVersion(1);
  assert.equal((await f.call(f.alice, MessageType.BOT_SCREEN_END, ref)).type, MessageType.BOT_SCREEN_REMOVED);
});

test('miniapp end rechecks a completed role mutation even before the WS epoch changes', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  await f.create();
  f.setPermissions('bob', Permission.ADMINISTRATOR);
  let reads = 0;
  f.race(() => {
    f.permissions.set('bob', f.defaultPermissions | Permission.MANAGE_SERVER);
    f.setRoleAccessVersion(1);
  }, 'bob', () => ++reads === 3);
  const denied = await f.call(f.bob, MessageType.BOT_SCREEN_END, f.ref());
  assert.equal(denied.type, MessageType.SERVER_ERROR);
  assert.ok(typeof denied.payload === 'object' && denied.payload !== null && 'code' in denied.payload);
  assert.equal(denied.payload.code, ProtocolErrorCode.PERMISSION_DENIED);
  assert.ok(f.service.get('game'));
  assert.equal(f.messages.some(({ message }) => message.type === MessageType.BOT_SCREEN_REMOVED), false);
});

test('screen cleanup rechecks an obsolete denial rather than removing a reauthorized instance', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  await f.create();
  f.permissions.set('alice', 0);
  f.race(() => {
    f.permissions.set('alice', f.defaultPermissions);
    f.setRoleAccessVersion(1);
  }, 'alice');
  await f.handler.revokeInvalid();
  assert.ok(f.service.get('game'));
  assert.equal(f.messages.some(({ message }) => message.type === MessageType.BOT_SCREEN_REMOVED), false);
});

test('the owning bot always receives terminal removal even when access vanished during its initial notification', async (t) => {
  const f = fixture(); t.after(() => f.handler.close());
  f.race(() => f.revoke('alice'), 'alice', () => !!f.service.get('game'));
  await f.create();
  await f.handler.revokeInvalid();
  assert.equal(f.service.get('game'), undefined);
  const terminal = f.messages.filter(({ session, message }) => {
    if (session !== f.bot || message.type !== MessageType.BOT_SCREEN_REMOVED) return false;
    return botScreenRemovedSchema.parse(message.payload).reason === 'access_revoked';
  });
  assert.equal(terminal.length, 1);
});
