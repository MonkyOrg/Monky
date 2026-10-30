import assert from 'node:assert/strict';
import { randomUUID, sign } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import {
  DEFAULT_PERMISSIONS, LIMITS, MessageType, PROTOCOL_VERSION, ProtocolErrorCode, createProtocolOffer,
  type LogEntry, type ProtocolMessage,
} from '@monky/shared';
import { Logger } from './infrastructure/logger/Logger';
import { CoturnManager } from './infrastructure/turn/CoturnManager';
import { MESSAGE_BUDGETS, WS_FLOW_LIMITS, type WsFlowLimits } from './infrastructure/websocket/flowControl';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';
import { createApprovedBotFixture, createFixture, identity, record, records, text, type Peer } from './testFixtures/bots';

type Fixture = Awaited<ReturnType<typeof createFixture>>;
type Member = Awaited<ReturnType<Fixture['human']>>;

/** Whatever the server sent this peer before answering a later request has already arrived. */
async function settled(peer: Peer): Promise<void> {
  assert.equal((await peer.request(MessageType.COMMANDS_LIST)).type, MessageType.COMMANDS_LIST_RESPONSE);
}

const join = async (member: Member, channelId: string) => {
  assert.equal((await member.peer.request(MessageType.VOICE_JOIN, { channelId })).type, MessageType.VOICE_USER_JOINED);
};

/** Lowers the transport limits for one test: they are shared by every server in this process. */
function withFlowLimits(t: TestContext, limits: Partial<WsFlowLimits>): void {
  WebSocketServer['flowLimits'] = { ...WS_FLOW_LIMITS, ...limits };
  t.after(() => { WebSocketServer['flowLimits'] = WS_FLOW_LIMITS; });
}

const closeCode = (peer: Peer) => new Promise<number>((resolve) => peer.ws.once('close', (code) => resolve(code)));

async function eventually(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Connections that have not authenticated yet, as the server counts them. */
const anonymousCount = (f: Fixture) => f.wsServer['anonymousSessions'].size;

/**
 * Makes the server see the next connections arrive from another address. The
 * test's sockets come from loopback, which is also where a reverse proxy or a
 * tunnel on the same host connects from.
 */
function arriveFrom(t: TestContext, f: Fixture): (address: string) => void {
  let current: string | undefined;
  const disguise = (_ws: WebSocket, req: IncomingMessage) => {
    if (current !== undefined) Object.defineProperty(req.socket, 'remoteAddress', { value: current });
  };
  f.wsServer['wss'].prependListener('connection', disguise);
  t.after(() => { f.wsServer['wss'].off('connection', disguise); });
  return (address) => { current = address; };
}

/** A connection the server drops right after the upgrade: the client may not even see it open. */
function dropped(f: Fixture): Promise<{ code: number; messages: string[] }> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    const socket = new WebSocket(f.url);
    socket.on('error', () => {});
    socket.on('message', (data) => messages.push(String(data)));
    socket.once('close', (code) => resolve({ code, messages }));
  });
}

async function authenticate(peer: Peer, nickname: string): Promise<void> {
  const keys = identity();
  const challenge = await peer.request(MessageType.AUTH_CONNECT, {
    protocolVersion: PROTOCOL_VERSION, nickname, publicKey: keys.publicKey, deviceId: randomUUID(),
  });
  assert.equal(challenge.type, MessageType.AUTH_CHALLENGE);
  const signature = sign(null, Buffer.from(text(challenge.payload.nonce), 'hex'), keys.privateKey).toString('hex');
  assert.equal((await peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, { signature })).type, MessageType.AUTH_SUCCESS);
}

test('a requestId above the limit is refused, never echoed nor relayed to anyone', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const author = await f.human('Request author');
  const witness = await f.human('Request witness');
  const authorSince = author.peer.messages.length;
  const witnessSince = witness.peer.messages.length;

  author.peer.send(MessageType.USER_CHANGE_NICKNAME, { newNickname: 'Oversized id' }, 'x'.repeat(LIMITS.MAX_REQUEST_ID_LENGTH + 1));
  const refused = await author.peer.wait((message) => message.type === MessageType.SERVER_ERROR, authorSince);
  assert.equal(refused.payload.code, ProtocolErrorCode.BAD_REQUEST);
  assert.equal(refused.requestId, undefined, 'the oversized id is not echoed back');

  const longest = 'y'.repeat(LIMITS.MAX_REQUEST_ID_LENGTH);
  author.peer.send(MessageType.USER_CHANGE_NICKNAME, { newNickname: 'Longest id' }, longest);
  const relayed = await witness.peer.wait((message) => message.type === MessageType.USER_UPDATED, witnessSince);
  assert.equal(record(relayed.payload.user).nickname, 'Longest id', 'the refused message reached nobody');
  assert.equal(relayed.requestId, longest, 'an id at the limit still works');
});

test('the Soundboard plays only to the call of its author, never server-wide, and is rate limited', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const author = await f.human('Sound author');
  const listener = await f.human('Sound listener');
  const elsewhere = await f.human('Other call');
  const idle = await f.human('Not in a call');
  const channels = records(record(author.auth.payload.server).channels);
  const voiceId = text(channels.find((channel) => channel.type === 'VOICE')?.id);
  const textId = text(channels.find((channel) => channel.type === 'TEXT')?.id);
  const other = await f.channelService.createChannel({ name: 'Other room', type: 'VOICE' });
  const otherVoiceId = text(other.channel?.id);
  const sound = (channelId: string) => ({
    channelId, soundName: 'Beep', mimeType: 'audio/wav',
    audioBase64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
  });
  const since = new Map([listener, elsewhere, idle].map((member) => [member, member.peer.messages.length]));
  const heard = (member: Member) => member.peer.messages.slice(since.get(member))
    .filter((message) => message.type === MessageType.SOUNDBOARD_PLAYED).length;

  // Outside a call nothing plays: servers used to relay this to everyone online.
  await author.peer.error(MessageType.SOUNDBOARD_PLAY, sound(voiceId), ProtocolErrorCode.BAD_REQUEST);
  await author.peer.error(MessageType.SOUNDBOARD_PLAY, sound(textId), ProtocolErrorCode.BAD_REQUEST);

  await join(author, voiceId);
  await join(listener, voiceId);
  await join(elsewhere, otherVoiceId);
  await author.peer.error(MessageType.SOUNDBOARD_PLAY, sound(otherVoiceId), ProtocolErrorCode.BAD_REQUEST);

  const played = await author.peer.request(MessageType.SOUNDBOARD_PLAY, sound(voiceId));
  assert.equal(played.type, MessageType.SOUNDBOARD_PLAYED, 'the author hears its own sound');
  await Promise.all([listener, elsewhere, idle].map((member) => settled(member.peer)));
  assert.deepEqual([heard(listener), heard(elsewhere), heard(idle)], [1, 0, 0],
    'only the participants of that call hear it');

  // Four refused or played sounds already count: the fifth plays, the sixth waits.
  assert.equal((await author.peer.request(MessageType.SOUNDBOARD_PLAY, sound(voiceId))).type, MessageType.SOUNDBOARD_PLAYED);
  await author.peer.error(MessageType.SOUNDBOARD_PLAY, sound(voiceId), ProtocolErrorCode.RATE_LIMITED);
  await settled(listener.peer);
  assert.equal(heard(listener), 2);
});

test('a connection that does not authenticate in time is closed, and an authenticated one stays', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  withFlowLimits(t, { AUTH_TIMEOUT_MS: 1_000 });
  const member = await f.human('Authenticated in time');
  const idle = await f.connect();
  const closed = closeCode(idle);
  await idle.barrier();

  assert.equal(await closed, 1008);
  // The member connected first, so its own deadline is already behind it.
  await settled(member.peer);
  assert.equal(member.peer.ws.readyState, WebSocket.OPEN);
  await eventually(() => anonymousCount(f) === 0, 'the closed connection stops counting as anonymous');
});

test('a large frame before authentication closes the connection unread, while members still send large ones', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const anonymous = await f.connect();
  const closed = closeCode(anonymous);
  anonymous.send(MessageType.AUTH_CONNECT, {
    protocolVersion: PROTOCOL_VERSION, nickname: 'Oversized', publicKey: identity().publicKey,
    password: 'x'.repeat(WS_FLOW_LIMITS.PREAUTH_MAX_FRAME_BYTES),
  });
  assert.equal(await closed, 1009);
  assert.deepEqual(anonymous.messages, [], 'refused before it was parsed or answered');

  const member = await f.human('Large frame member');
  const padded = await member.peer.request(MessageType.COMMANDS_LIST, { padding: 'x'.repeat(WS_FLOW_LIMITS.PREAUTH_MAX_FRAME_BYTES) });
  assert.equal(padded.type, MessageType.COMMANDS_LIST_RESPONSE);
});

test('a client address holds a bounded number of anonymous connections, freed once they authenticate or leave', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  withFlowLimits(t, { PREAUTH_MAX_SOCKETS_PER_ADDRESS: 3 });
  const from = arriveFrom(t, f);
  from('1.2.3.4');
  const waiting = [await f.connect(), await f.connect()];
  // The same client as a dual-stack listener reports it.
  from('::ffff:1.2.3.4');
  waiting.push(await f.connect());
  // PING is answered before authentication, so it proves each one was accepted.
  await Promise.all(waiting.map((peer) => peer.barrier()));

  assert.deepEqual(await dropped(f), { code: 1006, messages: [] }, 'dropped without a handshake');
  from('5.6.7.8');
  const elsewhere = await f.connect();
  await elsewhere.barrier();

  from('1.2.3.4');
  await authenticate(waiting[0], 'Frees a slot');
  const next = await f.connect();
  await next.barrier();

  await waiting[1].close();
  await eventually(() => f.wsServer['anonymousPerAddress'].get('1.2.3.4') === 2, 'the server notices the departure');
  const after = await f.connect();
  await after.barrier();

  await Promise.all([waiting[2], next, after, elsewhere].map((peer) => peer.close()));
  await eventually(() => anonymousCount(f) === 0 && f.wsServer['anonymousPerAddress'].size === 0, 'every slot is released');
  assert.equal(waiting[0].ws.readyState, WebSocket.OPEN, 'the authenticated connection is not affected');
});

test('clients behind a reverse proxy, a tunnel or a LAN do not share the limit of the address they arrive from', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  withFlowLimits(t, { PREAUTH_MAX_SOCKETS_PER_ADDRESS: 3 });
  const from = arriveFrom(t, f);
  const waiting: Peer[] = [];
  // A proxy on the same host, a container network and a LAN.
  for (const address of ['127.0.0.1', '::ffff:172.17.0.1', 'fd00::20']) {
    from(address);
    for (let index = 0; index < 4; index++) waiting.push(await f.connect());
  }
  await Promise.all(waiting.map((peer) => peer.barrier()));
  assert.equal(anonymousCount(f), waiting.length, 'every one of them was accepted');
  assert.equal(f.wsServer['anonymousPerAddress'].size, 0);
});

test('sockets held open to fill the server cannot keep out a member who authenticates', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  withFlowLimits(t, { PREAUTH_MAX_SOCKETS: 4 });
  // Behind a proxy they all share its address, so only the total bounds them.
  const idle = [await f.connect(), await f.connect(), await f.connect(), await f.connect()];
  await Promise.all(idle.map((peer) => peer.barrier()));
  const oldestClosed = closeCode(idle[0]);

  const member = await f.human('Gets in anyway');
  assert.equal(await oldestClosed, 1006, 'the oldest waiting connection made room');
  await Promise.all(idle.slice(1).map((peer) => peer.barrier()));
  assert.equal(anonymousCount(f), 3);

  // Filling it again only ever drops connections that are still waiting.
  const more = [await f.connect(), await f.connect()];
  await Promise.all(more.map((peer) => peer.barrier()));
  assert.equal(anonymousCount(f), 4);
  await settled(member.peer);
  assert.equal(member.peer.ws.readyState, WebSocket.OPEN);
});

test('a burst of status changes is cut at its budget, with no broadcast for the refused ones', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const member = await f.human('Status burst');
  const witness = await f.human('Status witness');
  const budget = MESSAGE_BUDGETS.get(MessageType.USER_UPDATE_BRB);
  assert.ok(budget);
  const since = witness.peer.messages.length;

  const answers = await Promise.all(Array.from({ length: 50 }, (_, index) =>
    member.peer.request(MessageType.USER_UPDATE_BRB, { brb: index % 2 === 0 })));
  assert.equal(answers.filter((answer) => answer.type === MessageType.USER_UPDATED).length, budget.max);
  assert.equal(answers.filter((answer) => answer.type === MessageType.SERVER_ERROR &&
    answer.payload.code === ProtocolErrorCode.RATE_LIMITED).length, 50 - budget.max);

  await settled(witness.peer);
  const relayed = witness.peer.messages.slice(since).filter((message) =>
    message.type === MessageType.USER_UPDATED && record(message.payload.user).id === member.id);
  assert.equal(relayed.length, budget.max);
});

test('a malformed authentication answer is refused without an error in the server log', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const failures: LogEntry[] = [];
  t.after(Logger.subscribe((entry) => { if (entry.level === 'ERROR') failures.push(entry); }));
  const anonymous = await f.connect();

  for (const payload of [null, {}, { signature: 42 }]) {
    const answer = await anonymous.request(MessageType.AUTH_CHALLENGE_RESPONSE, payload);
    assert.equal(answer.type, MessageType.SERVER_ERROR);
    assert.equal(answer.payload.code, ProtocolErrorCode.BAD_REQUEST);
  }
  assert.deepEqual(failures, []);
});

test('a recipient that stopped reading skips discardable messages, then is dropped', () => {
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  server['sessions'] = new Map();
  const ws = Object.create(WebSocket.prototype) as WebSocket;
  const sent: string[] = [];
  let buffered = 0;
  let terminated = 0;
  Object.defineProperty(ws, 'readyState', { get: () => terminated ? WebSocket.CLOSING : WebSocket.OPEN });
  Object.defineProperty(ws, 'bufferedAmount', { get: () => buffered });
  ws.send = (data: unknown) => { sent.push(String(data)); };
  ws.terminate = () => { terminated++; };
  const sound: ProtocolMessage = { type: MessageType.SOUNDBOARD_PLAYED, payload: { soundName: 'Late' } };
  const update: ProtocolMessage = { type: MessageType.USER_UPDATED, payload: { user: { id: 'someone' } } };
  const types = () => sent.map((data) => record(JSON.parse(data)).type);

  server.send(ws, sound);
  buffered = WS_FLOW_LIMITS.OUTBOUND_DISCARDABLE_BYTES + 1;
  server.send(ws, sound);
  server.send(ws, update);
  assert.deepEqual(types(), [MessageType.SOUNDBOARD_PLAYED, MessageType.USER_UPDATED],
    'a late sound is skipped, state still flows');

  buffered = WS_FLOW_LIMITS.OUTBOUND_MAX_BYTES + 1;
  server.send(ws, update);
  server.send(ws, update);
  assert.equal(terminated, 1, 'dropped once, so it reconnects and resynchronizes');
  assert.equal(sent.length, 2);
});

test('the heartbeat closes a connection only after its timeout, and nobody on a round that ran late', (t) => {
  t.mock.method(Logger, 'warn', () => {});
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  const pinged: string[] = [];
  const terminated: string[] = [];
  type Session = Parameters<WebSocketServer['handleDisconnect']>[0];
  const connection = (ip: string): Session => {
    const ws = Object.create(WebSocket.prototype) as WebSocket;
    ws.ping = () => { pinged.push(ip); };
    ws.terminate = () => { terminated.push(ip); };
    return { ws, ip, lastSeenAt: 0, messageQueue: Promise.resolve() };
  };
  const roaming = connection('roaming');
  const gone = connection('gone');
  server['sessions'] = new Map([roaming, gone].map((session) => [session.ws, session]));
  server['handleDisconnect'] = (session) => { server['sessions'].delete(session.ws); };
  let now = 100_000;
  roaming.lastSeenAt = gone.lastSeenAt = now - 8_000;
  server['lastLivenessCheckAt'] = now - LIMITS.HEARTBEAT_INTERVAL_MS;
  server['checkLiveness'](now);
  assert.deepEqual(terminated, [], 'eight seconds of silence, a Wi-Fi roam, no longer end the call');
  assert.deepEqual(pinged, ['roaming', 'gone']);

  // The server itself stalls for 30 s: answers that arrived meanwhile are still unread.
  now += 30_000;
  server['checkLiveness'](now);
  assert.deepEqual(terminated, [], 'a round that ran late drops nobody');

  // One of the answers is read, and the next round runs on time.
  roaming.lastSeenAt = now;
  now += LIMITS.HEARTBEAT_INTERVAL_MS;
  server['checkLiveness'](now);
  assert.deepEqual(terminated, ['gone'], 'only the connection still silent past the timeout goes');
  assert.deepEqual([...server['sessions'].values()], [roaming]);
});

test('any frame from a connection, not only a pong, keeps it alive', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const member = await f.human('Chatty member');
  const session = [...f.wsServer['sessions'].values()].find((entry) => entry.user?.id === member.id);
  assert.ok(session);
  session.lastSeenAt = 0;
  await member.peer.request(MessageType.COMMANDS_LIST);
  assert.ok(session.lastSeenAt > 0, 'a message refreshes the deadline');
  session.lastSeenAt = 0;
  session.ws.ping();
  await eventually(() => session.lastSeenAt > 0, 'the pong refreshes the deadline');
});

test('a device that reconnects lets its old connection go at once, and shutdown does not wait for that socket', { timeout: 15_000 }, async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const asker = await f.human('Asker');
  const player = await f.human('Player');
  const voiceId = text(records(record(asker.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  await player.peer.request(MessageType.USER_UPDATE_ACTIVITY, {
    activity: { source: 'steam', appId: 606150, name: 'Moonlighter', startedAt: 1_758_200_000_000 },
  });
  for (const member of [asker, player]) await join(member, voiceId);
  assert.equal((await asker.peer.request(MessageType.GAME_SHARE_REQUEST, { targetUserId: player.id })).type,
    MessageType.GAME_SHARE_REQUEST_SENT);
  const prompt = await player.peer.wait((message) => message.type === MessageType.GAME_SHARE_REQUESTED);

  // The old socket never finishes closing, like a laptop that went to sleep.
  const staleSocket = f.wsServer['sessionSockets'].get(text(record(asker.auth.payload.currentUser).sessionId));
  assert.ok(staleSocket);
  staleSocket.close = () => {};
  const since = player.peer.messages.length;
  const again = await f.human('Asker', asker.keys, asker.deviceId);
  const closed = await player.peer.wait((message) => message.type === MessageType.GAME_SHARE_CLOSED, since);
  assert.equal(closed.payload.shareRequestId, prompt.payload.shareRequestId, 'the ask of the old connection ends with it');
  assert.equal((await again.peer.request(MessageType.GAME_SHARE_REQUEST, { targetUserId: player.id })).type,
    MessageType.GAME_SHARE_REQUEST_SENT, 'the reconnected device can ask again right away');
  assert.equal(f.wsServer['wss'].clients.has(staleSocket), true, 'its socket is still open');

  const shutdown = f.wsServer.close().then(() => 'closed');
  const outcome = await Promise.race([shutdown, delay(LIMITS.SHUTDOWN_GRACE_MS + 1_000, 'stuck', { ref: false })]);
  // Let the fixture finish even when the shutdown would wait for that socket forever.
  if (outcome === 'stuck') staleSocket.terminate();
  assert.equal(outcome, 'closed', 'shutdown ends the replaced socket too, within its grace period');
  assert.equal(f.wsServer['wss'].clients.size, 0);
});

test('a kicked member is out at once, not shown online while its sockets finish closing', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Kick owner');
  const member = await f.human('Kicked member');
  const sessionId = text(record(member.auth.payload.currentUser).sessionId);
  const socket = f.wsServer['sessionSockets'].get(sessionId);
  assert.ok(socket);
  socket.close = () => {};
  assert.equal((await owner.peer.request(MessageType.MEMBER_KICK, { targetUserId: member.id })).type, MessageType.MEMBER_KICKED);
  assert.equal(f.wsServer.getOnlineUsersMap().has(sessionId), false);
  assert.equal(f.wsServer['sessions'].has(socket), false);
  assert.equal(f.wsServer['wss'].clients.has(socket), true, 'its socket is still closing');
});

const defaultRole = (id: string) => ({
  id, name: 'Member', color: null, position: 1, permissions: DEFAULT_PERMISSIONS, isDefault: true, createdAt: Date.now(),
});

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

/** Where a client received the snapshot it signed in with. */
function snapshotIndex(peer: Peer): number {
  const index = peer.messages.findIndex((message) => message.type === MessageType.AUTH_SUCCESS);
  assert.ok(index >= 0, 'signed in');
  return index;
}

/** The name a client ends up with for a channel: its snapshot's, then every change sent after it. */
function nameAfterSnapshot(peer: Peer, channelId: string): string {
  const snapshot = snapshotIndex(peer);
  let name = records(record(peer.messages[snapshot].payload.server).channels).find((channel) => channel.id === channelId)?.name;
  for (const message of peer.messages.slice(snapshot + 1)) {
    if ((message.type === MessageType.CHANNEL_UPDATED || message.type === MessageType.CHANNEL_CREATED) &&
        record(message.payload.channel).id === channelId) name = record(message.payload.channel).name;
  }
  return text(name);
}

test('signing in again changes nobody\'s access: the others only hear that the person is back (S-WS-4)', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  await f.roleRepo.create(defaultRole('returning-default'));
  const owner = await f.human('Login owner');
  const returning = await f.human('Returning member');
  const observer = await f.human('Login observer');
  const sharer = await f.human('Login sharer');
  const voiceId = text(records(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  await join(sharer, voiceId);
  await sharer.peer.request(MessageType.VOICE_STATE_UPDATE, {
    screenShareIds: ['login-screen'],
    nativeScreenShares: [{
      shareId: 'login-screen', instanceId: randomUUID(), audio: false,
      video: { width: 1920, height: 1080, fps: 30, maxBitrateKbps: 8000 },
    }],
  });
  await f.communityService.updateSettings(owner.id, { eventsEnabled: true });
  let binaryFrames = 0;
  observer.peer.ws.on('message', (_data, isBinary) => { if (isBinary) binaryFrames++; });
  // Past the community scheduler's first round, which publishes to everyone once.
  await delay(1_100);
  await settled(observer.peer);
  await returning.peer.close();
  await eventually(() => observer.peer.messages.some((message) =>
    message.type === MessageType.USER_CONNECTION_STATE && message.payload.status === 'reconnecting'), 'the drop is announced');
  const roleVersion = f.permissions.getRoleAccessVersion();
  const channelVersion = f.wsServer.getChannelAccessVersion();
  const since = observer.peer.messages.length;

  const again = await f.human('Returning member', returning.keys, returning.deviceId);
  await settled(again.peer);
  // A scheduler round would republish the community had the sign-in moved an access version.
  await delay(1_100);
  await settled(observer.peer);
  const received = observer.peer.messages.slice(since).map((message) => message.type);
  assert.ok(received.includes(MessageType.USER_JOINED), 'the person is back');
  for (const redundant of [MessageType.ROLES_LIST, MessageType.CATEGORIES_UPDATED, MessageType.CHANNEL_UPDATED,
    MessageType.CHANNEL_CREATED, MessageType.COMMUNITY_SNAPSHOT, MessageType.VOICE_STATE_CHANGED]) {
    assert.equal(received.includes(redundant), false, `${redundant} is not sent to everyone on a sign-in`);
  }
  assert.equal(f.permissions.getRoleAccessVersion(), roleVersion, 'a default role already held is not written again');
  assert.equal(f.wsServer.getChannelAccessVersion(), channelVersion);
  assert.equal(binaryFrames, 0, 'broadcasts reach clients as text frames');
});

test('a member given a default role on their first sign-in is announced with it (S-WS-4)', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  await f.roleRepo.create(defaultRole('first-default'));
  const owner = await f.human('Default owner');
  const since = owner.peer.messages.length;
  const newcomer = await f.human('Default newcomer');
  const roles = await owner.peer.wait((message) => message.type === MessageType.ROLES_LIST &&
    records(message.payload.userRoles).some((entry) => entry.userId === newcomer.id), since);
  assert.deepEqual(records(roles.payload.userRoles).find((entry) => entry.userId === newcomer.id)?.roleIds, ['first-default']);
});

test('a sign-in whose snapshot went stale is caught up with its roles and channels, rows included, even while another change runs', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Race owner');
  const publicId = text(records(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'TEXT')?.id);
  const cases: Array<{ moment: 'while the snapshot is read' | 'right before the snapshot is sent'; nickname: string; pending?: boolean }> = [
    { moment: 'while the snapshot is read', nickname: 'Early racer' },
    { moment: 'right before the snapshot is sent', nickname: 'Late racer' },
    // Another change, a settings save writing an icon say, still runs after AUTH_SUCCESS and publishes nothing about roles.
    { moment: 'while the snapshot is read', nickname: 'Pending racer', pending: true },
  ];
  for (const { moment, nickname, pending } of cases) {
    const member = await f.human(nickname);
    const role = { ...defaultRole(randomUUID()), name: `Race ${nickname}`, isDefault: false };
    await f.roleRepo.create(role);
    const created = await f.channelService.createChannel({ name: `race-${role.id.slice(0, 8)}`, type: 'TEXT', isPrivate: true, allowedRoleIds: [role.id] });
    const channelId = text(created.channel?.id);
    const renamed = `renamed-${role.id.slice(0, 8)}`;
    await member.peer.close();
    // What an administrator's ROLE_ASSIGN and CHANNEL_UPDATE do, landing at that moment of the sign-in.
    const change = async () => {
      assert.equal((await f.roleService.assignRole(owner.id, { userId: member.id, roleId: role.id })).success, true);
      await f.wsServer['broadcastRolesState']();
      assert.equal((await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: publicId, name: renamed })).type,
        MessageType.CHANNEL_UPDATED);
      if (pending) void f.wsServer['mutateLocalAccess'](() => delay(30));
    };
    let restore = () => {};
    if (moment === 'while the snapshot is read') {
      const verify = f.authService.verifyChallengeResponse.bind(f.authService);
      const mocked = t.mock.method(f.authService, 'verifyChallengeResponse',
        async (...args: Parameters<typeof verify>) => {
          const result = await verify(...args);
          await change();
          return result;
        });
      restore = () => mocked.mock.restore();
    } else {
      const ice = f.wsServer['buildIceServersFor'].bind(f.wsServer);
      f.wsServer['buildIceServersFor'] = async (userId, session) => {
        await change();
        return ice(userId, session);
      };
      restore = () => { f.wsServer['buildIceServersFor'] = ice; };
    }
    const again = await f.human(nickname, member.keys, member.deviceId);
    restore();
    const label = `${moment}${pending ? ', with another change running' : ''}`;
    assert.equal(records(record(again.auth.payload.server).channels).some((channel) => channel.id === channelId), false,
      `${label}: the snapshot predates the grant`);
    await settled(again.peer);
    const afterSnapshot = again.peer.messages.slice(again.peer.messages.findIndex((message) => message.type === MessageType.AUTH_SUCCESS));
    assert.ok(afterSnapshot.some((message) => message.type === MessageType.CHANNEL_CREATED &&
      record(message.payload.channel).id === channelId), `${label}: the channel the grant opened arrives after AUTH_SUCCESS`);
    const roles = afterSnapshot.filter((message) => message.type === MessageType.ROLES_LIST).at(-1);
    assert.ok(roles && records(roles.payload.userRoles).some((entry) => entry.userId === member.id &&
      Array.isArray(entry.roleIds) && entry.roleIds.includes(role.id)), `${label}: and so does the role`);
    assert.equal(nameAfterSnapshot(again.peer, publicId), renamed, `${label}: and the new name of a channel it kept`);
  }
});

test('the relay is probed before a sign-in reads anything, so a change made meanwhile reaches the member or bot (S-VOICE-6)', async (t) => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Probe owner');
  const channelId = text(records(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'TEXT')?.id);
  const token = text((await owner.peer.request(MessageType.BOT_CREATE, {})).payload.token);
  let probing = gate();
  let probe = gate();
  // On Linux the probe runs `which` and `sudo`: other connections are served meanwhile.
  t.mock.method(CoturnManager, 'availability', async () => {
    probing.open();
    await probe.opened;
    return { supported: true };
  });
  const renamedWhileProbing = async <T>(signIn: () => Promise<T>, name: string): Promise<T> => {
    probing = gate();
    probe = gate();
    const signingIn = signIn();
    await probing.opened;
    assert.equal((await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId, name })).type, MessageType.CHANNEL_UPDATED);
    probe.open();
    return signingIn;
  };
  // The snapshot itself has the change, and nothing reached the connection ahead of it: what is published
  // before AUTH_SUCCESS (messages, mentions, presence, settings) is overwritten, and no catch-up resends it.
  const snapshotName = (peer: Peer) => records(record(peer.messages[snapshotIndex(peer)].payload.server).channels)
    .find((channel) => channel.id === channelId)?.name;
  const beforeSnapshot = (peer: Peer) => peer.messages.slice(0, snapshotIndex(peer)).map((message) => message.type);

  const member = await renamedWhileProbing(() => f.human('Probe member'), 'renamed-for-member');
  assert.equal(snapshotName(member.peer), 'renamed-for-member');
  assert.deepEqual(beforeSnapshot(member.peer), [MessageType.AUTH_CHALLENGE]);
  const bot = await renamedWhileProbing(() => f.bot(token), 'renamed-for-bot');
  assert.equal(snapshotName(bot.peer), 'renamed-for-bot');
  assert.deepEqual(beforeSnapshot(bot.peer), []);
});

test('a fan-out serializes each message once, still projects it for older clients, and sends text frames (S-WS-8)', (t) => {
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  const frames: Array<{ to: string; data: unknown; options: unknown }> = [];
  const current = createProtocolOffer('client').features;
  type Session = Parameters<WebSocketServer['handleDisconnect']>[0];
  const connection = (id: string, features: typeof current, signedIn = true): Session => {
    const ws = Object.create(WebSocket.prototype) as WebSocket;
    Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
    Object.defineProperty(ws, 'bufferedAmount', { value: 0 });
    ws.send = (...args: unknown[]) => { frames.push({ to: id, data: args[0], options: args[1] }); };
    return {
      ws, ip: '127.0.0.1', lastSeenAt: 0, messageQueue: Promise.resolve(), sessionId: id,
      protocol: { version: PROTOCOL_VERSION, minimumVersion: PROTOCOL_VERSION, features: [...features] },
      user: signedIn ? { id, sessionId: id, clientId: id, nickname: id, status: 'ONLINE', joinedAt: 1 } : undefined,
    };
  };
  const replaced = { ...connection('replaced', current), replaced: true };
  const sessions = [
    connection('current-a', current), connection('current-b', current),
    connection('legacy', current.filter((feature) => feature !== 'message-forward')),
    replaced, connection('anonymous', current, false),
  ];
  server['sessions'] = new Map(sessions.map((session) => [session.ws, session]));
  const message: ProtocolMessage = {
    type: MessageType.CHAT_MESSAGE,
    payload: { id: 'forwarded', channelId: 'general', userId: 'author', content: 'Hello', createdAt: 1,
      forwarded: { source: '#news', createdAt: 1 } },
  };

  const stringify = t.mock.method(JSON, 'stringify');
  server.broadcast(message);
  const serializations = stringify.mock.callCount();
  stringify.mock.restore();

  assert.deepEqual(frames.map((frame) => frame.to), ['current-a', 'current-b', 'legacy'],
    'signed-in connections only, never one already replaced');
  assert.equal(serializations, 2, 'one serialization per distinct message, not per recipient');
  assert.ok(Buffer.isBuffer(frames[0].data));
  assert.equal(frames[0].data, frames[1].data, 'recipients of the same message share its bytes');
  for (const frame of frames) assert.deepEqual(frame.options, { binary: false }, 'a Buffer still goes out as a text frame');
  const payload = (index: number) => record(record(JSON.parse(String(frames[index].data))).payload);
  assert.deepEqual(payload(0).forwarded, { source: '#news', createdAt: 1 });
  assert.equal('forwarded' in payload(2), false, 'clients without message-forward still get their projection');
});
