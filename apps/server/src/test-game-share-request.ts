import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIMITS,
  MessageType,
  ProtocolErrorCode,
  type ProtocolMessage,
  type UserActivity,
} from '@monky/shared';
import {
  GameShareRequestService,
  type GameShareSession,
} from './application/services/GameShareRequestService';
import { createFixture, record, records, text } from './testFixtures/bots';

const game: UserActivity = { source: 'steam', appId: 606150, name: 'Moonlighter', startedAt: 1_758_200_000_000 };
const FEATURES = { features: ['game-activity', 'game-share-request'] };

interface FakeSession extends GameShareSession {
  name: string;
}

/** Sessions, calls, screens and a clock the test moves by hand. */
function harness() {
  const sessions: FakeSession[] = [];
  const channelOf = new Map<string, string>();
  const sharing = new Set<string>();
  const sent: Array<{ to: string; message: ProtocolMessage }> = [];
  let clock = 1_000;
  let timers: Array<{ id: number; at: number; run: () => void }> = [];
  let nextTimer = 1;
  const service = new GameShareRequestService<FakeSession>({
    send: (session, message) => sent.push({ to: session.name, message }),
    sessionsOfUser: (userId) => sessions.filter(session => session.user?.id === userId),
    voiceChannelOf: (sessionId) => channelOf.get(sessionId) ?? null,
    isScreenSharing: (userId) => sharing.has(userId),
  }, {
    now: () => clock,
    setTimeout: (run, ms) => {
      const id = nextTimer++;
      timers.push({ id, at: clock + ms, run });
      return id;
    },
    clearTimeout: (handle) => { timers = timers.filter(timer => timer.id !== handle); },
  });
  const add = (name: string, userId: string, options: Partial<FakeSession> & { channel?: string } = {}) => {
    const { channel = 'voice-1', ...rest } = options;
    const session: FakeSession = {
      name, sessionId: `${name}-session`, protocol: FEATURES,
      user: { id: userId, nickname: name, activity: null }, ...rest,
    };
    sessions.push(session);
    if (channel) channelOf.set(session.sessionId!, channel);
    return session;
  };
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.filter(candidate => candidate.at <= clock)) {
      timers = timers.filter(candidate => candidate !== timer);
      timer.run();
    }
  };
  const to = (name: string, type: MessageType) => sent.filter(entry => entry.to === name && entry.message.type === type);
  return { service, sessions, channelOf, sharing, sent, add, advance, to };
}

function shareRequestIdOf(message: ProtocolMessage): string {
  return text(record(message.payload).shareRequestId);
}

test('an ask reaches every device of the player in the call, and the answer goes back to the asker', () => {
  const h = harness();
  const asker = h.add('asker', 'user-a');
  const desktop = h.add('desktop', 'user-p', { user: { id: 'user-p', nickname: 'Player', activity: game } });
  const laptop = h.add('laptop', 'user-p', { user: { id: 'user-p', nickname: 'Player', activity: game } });
  h.add('elsewhere', 'user-p', { channel: 'voice-2', user: { id: 'user-p', nickname: 'Player', activity: game } });

  assert.equal(h.service.request(asker, { targetUserId: 'user-p' }, 'req-1'), null);
  const [sent] = h.to('asker', MessageType.GAME_SHARE_REQUEST_SENT);
  assert.equal(sent.message.requestId, 'req-1');
  const id = shareRequestIdOf(sent.message);
  assert.equal(record(sent.message.payload).expiresInMs, LIMITS.GAME_SHARE_REQUEST_TIMEOUT_MS);
  for (const device of ['desktop', 'laptop']) {
    const [prompt] = h.to(device, MessageType.GAME_SHARE_REQUESTED);
    assert.deepEqual(prompt.message.payload, {
      shareRequestId: id, fromUserId: 'user-a', nickname: 'asker', gameName: 'Moonlighter',
      expiresInMs: LIMITS.GAME_SHARE_REQUEST_TIMEOUT_MS,
    });
  }
  assert.equal(h.to('elsewhere', MessageType.GAME_SHARE_REQUESTED).length, 0, 'a device in another call is not asked');

  assert.equal(h.service.respond(laptop, { shareRequestId: id, accepted: true }), null);
  assert.deepEqual(h.to('asker', MessageType.GAME_SHARE_ANSWERED)[0].message.payload, { shareRequestId: id, outcome: 'accepted' });
  // The other device closes its prompt, and a late answer from it changes nothing.
  assert.equal(h.to('desktop', MessageType.GAME_SHARE_CLOSED).length, 1);
  assert.equal(h.service.respond(desktop, { shareRequestId: id, accepted: false }), null);
  assert.equal(h.to('asker', MessageType.GAME_SHARE_ANSWERED).length, 1);
});

test('every reason the ask cannot reach the player answers with the same error', () => {
  const h = harness();
  const asker = h.add('asker', 'user-a');
  const refused = (targetUserId: string) => {
    const error = h.service.request(asker, { targetUserId });
    assert.ok(error);
    return error;
  };
  h.add('idle', 'idle', { user: { id: 'idle', nickname: 'Idle', activity: null } });
  h.add('away', 'away', { channel: 'voice-2', user: { id: 'away', nickname: 'Away', activity: game } });
  h.add('hidden', 'hidden', { invisible: true, user: { id: 'hidden', nickname: 'Hidden', activity: game } });
  h.add('live', 'live', { user: { id: 'live', nickname: 'Live', activity: game } });
  h.sharing.add('live');
  h.add('old', 'old', { protocol: { features: ['game-activity'] }, user: { id: 'old', nickname: 'Old', activity: game } });

  const reference = refused('idle');
  assert.equal(reference.code, ProtocolErrorCode.PERMISSION_DENIED);
  for (const target of ['away', 'hidden', 'live', 'old', 'nobody', 'user-a']) {
    assert.deepEqual(refused(target), reference, `${target} must be indistinguishable`);
  }
  assert.equal(h.sent.length, 0, 'no prompt went anywhere');

  const bot = h.add('bot', 'bot', { isBot: true });
  assert.equal(h.service.request(bot, { targetUserId: 'live' })?.code, ProtocolErrorCode.PERMISSION_DENIED);
  const legacy = h.add('legacy', 'legacy', { protocol: { features: ['game-activity'] } });
  assert.equal(h.service.request(legacy, { targetUserId: 'live' })?.code, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
  assert.equal(h.service.request(asker, { targetUserId: 7 })?.code, ProtocolErrorCode.BAD_REQUEST);
});

test('a refusal and a timeout look the same to the asker, and both start the wait', () => {
  const h = harness();
  const asker = h.add('asker', 'user-a');
  const player = h.add('player', 'user-p', { user: { id: 'user-p', nickname: 'Player', activity: game } });

  h.service.request(asker, { targetUserId: 'user-p' });
  assert.equal(h.service.request(asker, { targetUserId: 'user-p' })?.code, ProtocolErrorCode.RATE_LIMITED, 'one pending ask per pair');
  h.advance(LIMITS.GAME_SHARE_REQUEST_TIMEOUT_MS);
  const timedOut = h.to('asker', MessageType.GAME_SHARE_ANSWERED)[0].message;
  assert.equal(record(timedOut.payload).outcome, 'not-accepted');
  assert.equal(h.to('player', MessageType.GAME_SHARE_CLOSED).length, 1, 'the prompt closes when time runs out');

  assert.equal(h.service.request(asker, { targetUserId: 'user-p' })?.code, ProtocolErrorCode.RATE_LIMITED);
  h.advance(LIMITS.GAME_SHARE_REQUEST_COOLDOWN_MS);
  assert.equal(h.service.request(asker, { targetUserId: 'user-p' }), null, 'asking again after the wait');
  const id = shareRequestIdOf(h.to('asker', MessageType.GAME_SHARE_REQUEST_SENT)[1].message);
  h.service.respond(player, { shareRequestId: id, accepted: false });
  const refused = h.to('asker', MessageType.GAME_SHARE_ANSWERED)[1].message;
  assert.deepEqual(Object.keys(record(refused.payload)), Object.keys(record(timedOut.payload)));
  assert.equal(record(refused.payload).outcome, 'not-accepted');
  assert.equal(h.service.request(asker, { targetUserId: 'user-p' })?.code, ProtocolErrorCode.RATE_LIMITED);
});

test('going live, leaving and disconnecting close pending asks', () => {
  const h = harness();
  const asker = h.add('asker', 'user-a');
  const player = h.add('player', 'user-p', { user: { id: 'user-p', nickname: 'Player', activity: game } });

  h.service.request(asker, { targetUserId: 'user-p' });
  h.service.playerStartedSharing('user-p');
  assert.equal(record(h.to('asker', MessageType.GAME_SHARE_ANSWERED)[0].message.payload).outcome, 'accepted');
  assert.equal(h.to('player', MessageType.GAME_SHARE_CLOSED).length, 1);

  // Accepting after the asker left the call is not an acceptance.
  h.advance(LIMITS.GAME_SHARE_REQUEST_COOLDOWN_MS);
  h.service.request(asker, { targetUserId: 'user-p' });
  const id = shareRequestIdOf(h.to('asker', MessageType.GAME_SHARE_REQUEST_SENT)[1].message);
  h.channelOf.delete('asker-session');
  h.service.respond(player, { shareRequestId: id, accepted: true });
  assert.equal(record(h.to('asker', MessageType.GAME_SHARE_ANSWERED)[1].message.payload).outcome, 'not-accepted');

  // The asker disconnecting drops the ask without an answer to nobody.
  h.channelOf.set('asker-session', 'voice-1');
  h.advance(LIMITS.GAME_SHARE_REQUEST_COOLDOWN_MS);
  h.service.request(asker, { targetUserId: 'user-p' });
  const closedBefore = h.to('player', MessageType.GAME_SHARE_CLOSED).length;
  h.service.sessionClosed(asker);
  assert.equal(h.to('player', MessageType.GAME_SHARE_CLOSED).length, closedBefore + 1);
  assert.equal(h.to('asker', MessageType.GAME_SHARE_ANSWERED).length, 2);

  // The player's only prompted device disconnecting answers "not accepted".
  h.service.request(asker, { targetUserId: 'user-p' });
  h.service.sessionClosed(player);
  assert.equal(record(h.to('asker', MessageType.GAME_SHARE_ANSWERED)[2].message.payload).outcome, 'not-accepted');
  h.advance(LIMITS.GAME_SHARE_REQUEST_TIMEOUT_MS);
  assert.equal(h.to('asker', MessageType.GAME_SHARE_ANSWERED).length, 3, 'no second answer once the ask closed');
});

test('the WebSocket server relays the ask between two people in the same call', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const asker = await f.human('Asker');
  const player = await f.human('Player');
  const room = text(records(record(asker.auth.payload.server).channels).find(channel => channel.type === 'VOICE')?.id);
  await player.peer.request(MessageType.USER_UPDATE_ACTIVITY, { activity: game });

  await asker.peer.error(MessageType.GAME_SHARE_REQUEST, { targetUserId: player.id }, ProtocolErrorCode.PERMISSION_DENIED);
  for (const user of [asker, player]) {
    assert.equal((await user.peer.request(MessageType.VOICE_JOIN, { channelId: room })).type, MessageType.VOICE_USER_JOINED);
  }

  const promptStart = player.peer.messages.length;
  const sent = await asker.peer.request(MessageType.GAME_SHARE_REQUEST, { targetUserId: player.id });
  assert.equal(sent.type, MessageType.GAME_SHARE_REQUEST_SENT);
  const prompt = await player.peer.wait(message => message.type === MessageType.GAME_SHARE_REQUESTED, promptStart);
  assert.equal(prompt.payload.gameName, 'Moonlighter');
  assert.equal(prompt.payload.fromUserId, asker.id);

  const answerStart = asker.peer.messages.length;
  player.peer.send(MessageType.GAME_SHARE_RESPONSE, { shareRequestId: prompt.payload.shareRequestId, accepted: true });
  const answered = await asker.peer.wait(message => message.type === MessageType.GAME_SHARE_ANSWERED, answerStart);
  assert.deepEqual(answered.payload, { shareRequestId: prompt.payload.shareRequestId, outcome: 'accepted' });

  // Once the player is on screen there is nothing to ask for.
  const announce = { screenShareIds: ['live'], isScreenSharing: true };
  assert.equal((await player.peer.request(MessageType.VOICE_STATE_UPDATE, announce)).type, MessageType.VOICE_STATE_CHANGED);
  await asker.peer.error(MessageType.GAME_SHARE_REQUEST, { targetUserId: player.id }, ProtocolErrorCode.PERMISSION_DENIED);
});
