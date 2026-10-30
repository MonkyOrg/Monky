import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { MessageType, Permission, ProtocolErrorCode, type BotCapability, type UserSummary } from '@monky/shared';
import type { ClientSession } from './infrastructure/websocket/ClientSession';
import { Logger } from './infrastructure/logger/Logger';
import { MessageRouter, route, type Route, type RouterHost } from './infrastructure/websocket/routing/MessageRouter';

/** A router over a host that records every check it is asked for, and every refusal it answers. */
function fixture(options: {
  revoked?: boolean; budget?: boolean; permission?: boolean; channel?: boolean;
  approved?: (capabilities: BotCapability[]) => boolean;
} = {}) {
  const steps: string[] = [];
  const refusals: Array<{ code: ProtocolErrorCode; message: string; requestId?: string }> = [];
  const host: RouterHost = {
    rateLimiter: { checkLimit: (key) => { steps.push(`budget ${key.split(':')[1]}`); return options.budget ?? true; } },
    authorizer: {
      requirePermission: async (_session, permission) => { steps.push(`permission ${permission}`); return options.permission ?? true; },
      authorizeChannel: async (_session, channelId, permissions) => {
        steps.push(`channel ${String(channelId)} ${permissions.join(',')}`);
        return options.channel ?? true;
      },
    },
    isRevoked: () => options.revoked ?? false,
    isCurrentBotOperation: (_session, ...capabilities) => {
      steps.push(`bot ${capabilities.join(',')}`);
      return options.approved?.(capabilities) ?? true;
    },
    sendError: (_ws, code, message, requestId) => { refusals.push({ code, message, requestId }); },
  };
  return { steps, refusals, router: new MessageRouter(host) };
}

function session(user?: Partial<UserSummary>, isBot = false): ClientSession {
  const ws = Object.create(WebSocket.prototype) as WebSocket;
  return {
    ws, ip: '127.0.0.1', lastSeenAt: 0, messageQueue: Promise.resolve(), isBot,
    user: user && { id: 'member', clientId: 'member', nickname: 'Member', status: 'ONLINE', joinedAt: 1, ...user },
  };
}

const reaction = z.object({ channelId: z.string(), emoji: z.string() });

test('a message goes through availability, shape, server permission and channel access, in that order, before its handler', async () => {
  const f = fixture();
  const handled: unknown[] = [];
  let available = true;
  f.router.register(route({
    types: [MessageType.CHAT_REACTION_ADD],
    unavailable: { when: () => { f.steps.push('available'); return !available; }, message: 'Update first.' },
    schema: { type: reaction, message: 'Invalid reaction.' },
    permission: Permission.MANAGE_SERVER,
    channel: { id: (payload) => payload.channelId, permissions: [Permission.SEND_MESSAGES] },
    handle: ({ payload }) => { f.steps.push('handler'); handled.push(payload); },
  }));
  const member = session({});
  await f.router.dispatch(member, { type: MessageType.CHAT_REACTION_ADD, requestId: 'ok', payload: { channelId: 'room', emoji: 'x', extra: 1 } });
  assert.deepEqual(f.steps, ['available', `permission ${Permission.MANAGE_SERVER}`, `channel room ${Permission.SEND_MESSAGES}`, 'handler']);
  assert.deepEqual(handled, [{ channelId: 'room', emoji: 'x' }], 'the handler gets the payload as the schema read it');

  f.steps.length = 0;
  await f.router.dispatch(member, { type: MessageType.CHAT_REACTION_ADD, requestId: 'shape', payload: { channelId: 7 } });
  assert.deepEqual(f.steps, ['available'], 'a payload that does not fit stops before any access is read');
  assert.deepEqual(f.refusals.at(-1), { code: ProtocolErrorCode.BAD_REQUEST, message: 'Invalid reaction.', requestId: 'shape' });

  f.steps.length = 0;
  available = false;
  await f.router.dispatch(member, { type: MessageType.CHAT_REACTION_ADD, requestId: 'old', payload: { channelId: 'room', emoji: 'x' } });
  assert.deepEqual(f.steps, ['available']);
  assert.deepEqual(f.refusals.at(-1), { code: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, message: 'Update first.', requestId: 'old' });
  assert.equal(handled.length, 1);
});

test('a refused permission or channel stops the message there', async () => {
  for (const refused of ['permission', 'channel'] as const) {
    const f = fixture({ [refused]: false });
    let handled = false;
    f.router.register(route({
      types: [MessageType.CHAT_SEND], permission: Permission.SEND_MESSAGES,
      channel: { id: () => 'room' },
      handle: () => { handled = true; },
    }));
    await f.router.dispatch(session({}), { type: MessageType.CHAT_SEND, payload: {} });
    assert.equal(handled, false, refused);
    assert.equal(f.steps.at(-1)?.split(' ')[0], refused, `${refused} is the last check run`);
  }
});

test('connections are checked before any route: let go, signing in twice, anonymous and unauthenticated', async () => {
  const revoked = fixture({ revoked: true });
  let handled = 0;
  const routes = (f: ReturnType<typeof fixture>) => f.router.register(
    route({ types: [MessageType.PING], anonymous: true, unordered: true, handle: () => { handled++; } }),
    route({ types: [MessageType.AUTH_CONNECT], anonymous: true, handle: () => { handled++; } }),
    route({ types: [MessageType.CHAT_SEND], handle: () => { handled++; } }),
  );
  routes(revoked);
  await revoked.router.dispatch(session({}), { type: MessageType.PING, payload: {} });
  assert.equal(handled, 0, 'a connection let go is not answered, not even a heartbeat');
  assert.deepEqual(revoked.refusals, []);

  const f = fixture();
  routes(f);
  await f.router.dispatch(session({}), { type: MessageType.AUTH_CONNECT, requestId: 'again', payload: {} });
  assert.deepEqual(f.refusals.at(-1), { code: ProtocolErrorCode.BAD_REQUEST, message: 'Esta conexão já está autenticada.', requestId: 'again' });
  const anonymous = session();
  await f.router.dispatch(anonymous, { type: MessageType.PING, payload: {} });
  await f.router.dispatch(anonymous, { type: MessageType.AUTH_CONNECT, payload: {} });
  assert.equal(handled, 2, 'the heartbeat and the handshake need no authentication');
  await f.router.dispatch(anonymous, { type: MessageType.CHAT_SEND, requestId: 'early', payload: {} });
  await f.router.dispatch(anonymous, { type: MessageType.CHAT_MESSAGE, requestId: 'unknown', payload: {} });
  assert.equal(handled, 2);
  assert.deepEqual(f.refusals.slice(-2).map(({ code, requestId }) => [code, requestId]),
    [[ProtocolErrorCode.UNAUTHORIZED, 'early'], [ProtocolErrorCode.UNAUTHORIZED, 'unknown']],
    'authentication comes before anything else, even a type nothing answers');
  assert.equal(f.router.isOrdered(MessageType.PING), false, 'the heartbeat skips the queue');
  assert.equal(f.router.isOrdered(MessageType.CHAT_SEND), true);
});

test('a bot is refused every message its policy does not list, before the budget and the route run (fail closed)', async () => {
  const f = fixture({ approved: (capabilities) => !capabilities.includes('send_messages') });
  let handled = 0;
  f.router.register(
    route({ types: [MessageType.ROLE_ASSIGN], permission: Permission.MANAGE_ROLES, handle: () => { handled++; } }),
    route({ types: [MessageType.CHAT_SEND], channel: { id: () => 'room' }, handle: () => { handled++; } }),
    route({ types: [MessageType.CHAT_LOAD_HISTORY], handle: () => { handled++; } }),
  );
  const bot = session({ id: 'bot', isBot: true }, true);
  await f.router.dispatch(bot, { type: MessageType.ROLE_ASSIGN, requestId: 'unlisted', payload: {} });
  assert.deepEqual(f.refusals.at(-1)?.code, ProtocolErrorCode.PERMISSION_DENIED, 'no bot policy, no access');
  assert.deepEqual(f.steps, [], 'nothing else is checked for it');
  await f.router.dispatch(bot, { type: MessageType.CHAT_SEND, requestId: 'unapproved', payload: {} });
  assert.deepEqual(f.refusals.at(-1)?.code, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED, 'listed, but not approved');
  assert.deepEqual(f.steps, ['bot send_messages']);
  await f.router.dispatch(bot, { type: MessageType.CHAT_LOAD_HISTORY, payload: {} });
  assert.equal(handled, 1, 'listed and approved');
  assert.deepEqual(f.steps.slice(-2), ['bot read_messages', `budget ${MessageType.CHAT_LOAD_HISTORY}`]);
});

test('a type answered by two routes is refused when the routes are registered', () => {
  const f = fixture();
  const first: Route = route({ types: [MessageType.POLL_GET, MessageType.POLL_VOTE], handle: () => {} });
  const second: Route = route({ types: [MessageType.POLL_VOTE], handle: () => {} });
  assert.throws(() => f.router.register(first, second), /More than one route answers POLL_VOTE/);
});

test('an expensive message over its budget, or a type nothing answers, never reaches a handler', async (t) => {
  t.mock.method(Logger, 'warn', () => {});
  const limited = fixture({ budget: false });
  let handled = 0;
  limited.router.register(route({ types: [MessageType.CHAT_LOAD_HISTORY], handle: () => { handled++; } }));
  await limited.router.dispatch(session({}), { type: MessageType.CHAT_LOAD_HISTORY, requestId: 'flood', payload: {} });
  assert.equal(handled, 0);
  assert.deepEqual(limited.refusals.at(-1)?.code, ProtocolErrorCode.RATE_LIMITED);

  const f = fixture();
  await f.router.dispatch(session({}), { type: MessageType.CHAT_MESSAGE, requestId: 'server-only', payload: {} });
  assert.deepEqual(f.refusals.at(-1), {
    code: ProtocolErrorCode.BAD_REQUEST, message: `Tipo de mensagem não suportado: ${MessageType.CHAT_MESSAGE}`, requestId: 'server-only',
  });
});
