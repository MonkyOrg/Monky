import assert from 'node:assert/strict';
import { randomUUID, sign } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { LIMITS, MessageType, PROTOCOL_VERSION, ProtocolErrorCode, type LogEntry, type ProtocolMessage } from '@monky/shared';
import { Logger } from './infrastructure/logger/Logger';
import { MESSAGE_BUDGETS, WS_FLOW_LIMITS, type WsFlowLimits } from './infrastructure/websocket/flowControl';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';
import { createFixture, identity, record, records, text, type Peer } from './testFixtures/bots';

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
