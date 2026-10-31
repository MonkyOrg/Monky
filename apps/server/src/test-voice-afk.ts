import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, type KeyPairKeyObjectResult } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { LIMITS, MessageType, PROTOCOL_VERSION, Permission, ProtocolErrorCode, type ProtocolMessage } from '@monky/shared';
import { LanBroadcaster } from './infrastructure/discovery/LanBroadcaster';
import { MonkyServer } from './server';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === 'string');
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

type Match = (message: ProtocolMessage<unknown>) => boolean;

/** A raw protocol client that keeps every message, so broadcasts can be awaited after the fact. */
class Peer {
  private readonly messages: ProtocolMessage<unknown>[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const parsed = record(JSON.parse(data.toString()));
      const type = Object.values(MessageType).find(value => value === parsed.type);
      assert.ok(type, `unknown message type ${String(parsed.type)}`);
      this.messages.push({ type, requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined, payload: parsed.payload });
      for (const listener of this.listeners) listener();
    });
  }

  mark(): number {
    return this.messages.length;
  }

  since(from: number): ProtocolMessage<unknown>[] {
    return this.messages.slice(from);
  }

  send(type: MessageType, payload: unknown): void {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  request(type: MessageType, payload: unknown = {}): Promise<ProtocolMessage<unknown>> {
    const requestId = randomUUID();
    const reply = this.next(message => message.requestId === requestId, `${type} reply`);
    this.ws.send(JSON.stringify({ type, payload, requestId }));
    return reply;
  }

  next(match: Match, label: string, from = this.mark()): Promise<ProtocolMessage<unknown>> {
    return new Promise((resolve, reject) => {
      const found = () => this.messages.slice(from).find(match);
      const check = () => {
        const message = found();
        if (!message) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Timed out waiting for ${label}.`));
      }, 5000);
      this.listeners.add(check);
      check();
    });
  }
}

interface Identity { pair: KeyPairKeyObjectResult; deviceId: string }
type Member = Awaited<ReturnType<Awaited<ReturnType<typeof realServer>>['connect']>>;

async function realServer(t: TestContext) {
  const dataDir = path.join(__dirname, '..', `.afk-test-${process.pid}-${randomUUID()}`);
  const sockets: WebSocket[] = [];
  const server = await MonkyServer.create({ dataDir, port: 0, discoveryPort: 0, serverName: 'Rooms', maxUsers: 20, voiceMode: 'p2p' });
  t.after(async () => {
    try {
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.CLOSED) continue;
        const closed = once(ws, 'close');
        ws.terminate();
        await closed;
      }
      await server.stop();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await server.start();
  const port = (await server.getStats()).port;
  const connect = async (nickname: string, identity: Identity = { pair: generateKeyPairSync('ed25519'), deviceId: randomUUID() }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    const peer = new Peer(ws);
    await once(ws, 'open');
    const challenge = await peer.request(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION, nickname, deviceId: identity.deviceId,
      publicKey: identity.pair.publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
    });
    const signature = sign(null, Buffer.from(text(record(challenge.payload).nonce), 'hex'), identity.pair.privateKey).toString('hex');
    const auth = await peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, { signature });
    assert.equal(auth.type, MessageType.AUTH_SUCCESS);
    const payload = record(auth.payload);
    const user = record(payload.currentUser);
    return { peer, identity, id: text(user.id), sessionId: text(user.sessionId), details: record(payload.server) };
  };
  return { connect };
}

const join = (member: Member, channelId: string, isMuted = false) =>
  member.peer.request(MessageType.VOICE_JOIN, { channelId, isMuted, isDeafened: false });
const voiceState = (message: ProtocolMessage<unknown>) => record(record(message.payload).voiceState);
const arrival = (sessionId: string, channelId: string): Match => message =>
  message.type === MessageType.VOICE_USER_JOINED && record(message.payload).sessionId === sessionId
  && record(message.payload).channelId === channelId;

test('voice user limit: rooms start unlimited, full rooms refuse members, Move Members and administrators exceed it', { timeout: 60_000 }, async (t) => {
  t.mock.method(LanBroadcaster.prototype, 'start', async () => {});
  const f = await realServer(t);
  const owner = await f.connect('Owner');
  const alice = await f.connect('Alice');
  const bob = await f.connect('Bob');
  const carol = await f.connect('Carol');
  const mover = await f.connect('Mover');
  const channels = records(owner.details.channels);
  const lobby = channels.find(channel => channel.type === 'VOICE');
  const textChannel = channels.find(channel => channel.type === 'TEXT');
  assert.ok(lobby && textChannel);
  assert.equal(lobby.maxParticipants, LIMITS.VOICE_USER_LIMIT_NONE, 'new servers start without a user limit');
  assert.equal(textChannel.maxParticipants, LIMITS.VOICE_USER_LIMIT_NONE);

  const created = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'Duo', type: 'VOICE', maxParticipants: 2 });
  assert.equal(created.type, MessageType.CHANNEL_CREATED);
  const duoId = text(record(record(created.payload).channel).id);
  assert.equal(record(record(created.payload).channel).maxParticipants, 2);
  for (const [channelId, maxParticipants] of [
    [text(textChannel.id), 5], [duoId, LIMITS.VOICE_USER_LIMIT_MAX + 1], [duoId, -1], [duoId, 1.5],
  ] as const) {
    const refused = await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId, maxParticipants });
    assert.equal(refused.type, MessageType.SERVER_ERROR, `a limit of ${maxParticipants} on ${channelId} is refused`);
  }

  assert.equal((await join(alice, duoId)).type, MessageType.VOICE_USER_JOINED);
  assert.equal((await join(bob, duoId)).type, MessageType.VOICE_USER_JOINED);
  const full = await join(carol, duoId);
  assert.equal(full.type, MessageType.SERVER_ERROR);
  assert.equal(record(full.payload).code, ProtocolErrorCode.CHANNEL_FULL);
  assert.equal((await join(bob, duoId)).type, MessageType.VOICE_USER_JOINED, 'someone already inside is never turned away');

  assert.equal((await join(owner, duoId)).type, MessageType.VOICE_USER_JOINED, 'administrators exceed the limit');
  const roles = await owner.peer.request(MessageType.ROLE_CREATE, { name: 'Movers', permissions: Permission.MOVE_MEMBERS });
  const role = records(record(roles.payload).roles).find(entry => entry.name === 'Movers');
  assert.ok(role);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: mover.id, roleId: text(role.id) });
  assert.equal((await join(mover, duoId)).type, MessageType.VOICE_USER_JOINED, 'Move Members exceeds the limit');

  assert.equal((await join(carol, text(lobby.id))).type, MessageType.VOICE_USER_JOINED);
  const moved = await mover.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: carol.sessionId, channelId: duoId });
  assert.equal(moved.type, MessageType.ADMIN_MOVE_USER, 'Move Members brings someone into a full room');
  assert.equal((await join(carol, duoId)).type, MessageType.VOICE_USER_JOINED,
    'the moved member announces itself again inside the full room, as its client does');

  const unlimited = await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: duoId, maxParticipants: 0 });
  assert.equal(record(record(unlimited.payload).channel).maxParticipants, LIMITS.VOICE_USER_LIMIT_NONE, '0 removes the limit');
});

test('AFK channel: set up in server settings, entered only when idle, muted by the server and kept across a dropped socket', { timeout: 60_000 }, async (t) => {
  t.mock.method(LanBroadcaster.prototype, 'start', async () => {});
  const f = await realServer(t);
  const owner = await f.connect('Owner');
  const alice = await f.connect('Alice');
  const bob = await f.connect('Bob');
  const lobbyId = text(records(owner.details.channels).find(channel => channel.type === 'VOICE')?.id);
  const textId = text(records(owner.details.channels).find(channel => channel.type === 'TEXT')?.id);
  assert.equal(owner.details.afkChannelId, null);
  assert.equal(owner.details.afkTimeoutSeconds, LIMITS.AFK_TIMEOUT_DEFAULT_SECONDS);

  for (const invalid of [
    { afkChannelEnabled: true, afkTimeoutSeconds: 123 },
    { afkChannelEnabled: true, afkChannelName: 'x' },
    { afkChannelEnabled: 'yes' },
  ]) {
    const refused = await owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, invalid);
    assert.equal(refused.type, MessageType.SERVER_ERROR, `${JSON.stringify(invalid)} is refused`);
  }
  const enabled = await owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, {
    afkChannelEnabled: true, afkChannelName: 'Ausentes', afkTimeoutSeconds: 300,
  });
  assert.equal(enabled.type, MessageType.SERVER_SETTINGS_UPDATED);
  const afkId = text(record(enabled.payload).afkChannelId);
  assert.equal(record(enabled.payload).afkTimeoutSeconds, 300);

  const deleted = await owner.peer.request(MessageType.CHANNEL_DELETE, { channelId: afkId });
  assert.equal(deleted.type, MessageType.SERVER_ERROR, 'the AFK room is only removed from the server settings');
  const limited = await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: afkId, maxParticipants: 3 });
  assert.equal(limited.type, MessageType.SERVER_ERROR, 'the AFK room has no user limit');
  for (const member of [alice, owner]) {
    const refused = await member.peer.request(MessageType.VOICE_JOIN, { channelId: afkId });
    assert.equal(record(refused.payload).code, ProtocolErrorCode.PERMISSION_DENIED,
      'nobody enters the AFK room on purpose, administrators included');
  }

  assert.equal((await join(alice, lobbyId)).type, MessageType.VOICE_USER_JOINED);
  assert.equal((await join(bob, lobbyId)).type, MessageType.VOICE_USER_JOINED);
  const forced = await owner.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: bob.sessionId, channelId: afkId });
  assert.equal(record(forced.payload).code, ProtocolErrorCode.PERMISSION_DENIED, 'nobody is moved into the AFK room by hand');

  let from = alice.peer.mark();
  alice.peer.send(MessageType.VOICE_AFK, { channelId: textId });
  await alice.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId: textId });
  assert.equal(alice.peer.since(from).some(message => message.type === MessageType.ADMIN_MOVE_USER), false,
    'a report naming another room moves nobody');

  from = bob.peer.mark();
  alice.peer.send(MessageType.VOICE_AFK, { channelId: lobbyId });
  const move = await alice.peer.next(message => message.type === MessageType.ADMIN_MOVE_USER, 'AFK move');
  const payload = move.payload;
  assert.ok(typeof payload === 'object' && payload !== null && 'moveId' in payload && typeof payload.moveId === 'string',
    'the AFK move is followed like any other (voice-move-id)');
  const { moveId: _followed, ...notice } = payload;
  assert.deepEqual(notice, { targetSessionId: alice.sessionId, channelId: afkId });
  const seen = await bob.peer.next(arrival(alice.sessionId, afkId), 'AFK arrival', from);
  assert.equal(voiceState(seen).permissionMuted, true, 'the server mutes whoever is in the AFK room');
  const followed = await join(alice, afkId);
  assert.equal(followed.type, MessageType.VOICE_USER_JOINED, 'the moved client follows into the AFK room');
  assert.equal(voiceState(followed).permissionMuted, true);
  const sound = await alice.peer.request(MessageType.SOUNDBOARD_PLAY, { channelId: afkId, soundName: 'beep', audioBase64: 'AAAA' });
  assert.equal(record(sound.payload).code, ProtocolErrorCode.PERMISSION_DENIED, 'the Soundboard is silent in the AFK room');

  from = bob.peer.mark();
  const pulled = await owner.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: alice.sessionId, channelId: lobbyId });
  assert.equal(pulled.type, MessageType.ADMIN_MOVE_USER);
  const back = voiceState(await bob.peer.next(arrival(alice.sessionId, lobbyId), 'return from AFK', from));
  assert.equal(back.permissionMuted, false);
  assert.equal(back.isMuted, true, 'pulled out of the AFK room, the member keeps an ordinary mute');

  from = alice.peer.mark();
  alice.peer.send(MessageType.VOICE_AFK, { channelId: lobbyId });
  await alice.peer.next(message => message.type === MessageType.ADMIN_MOVE_USER, 'second AFK move', from);
  const own = await join(alice, lobbyId, false);
  assert.equal(voiceState(own).isMuted, true, 'leaving the AFK room by oneself also arrives muted');
  from = bob.peer.mark();
  alice.peer.send(MessageType.VOICE_STATE_UPDATE, { isMuted: false });
  const unmuted = await bob.peer.next(message => message.type === MessageType.VOICE_STATE_CHANGED
    && voiceState(message).sessionId === alice.sessionId, 'unmute', from);
  assert.equal(voiceState(unmuted).isMuted, false, 'only the member undoes that mute');

  from = owner.peer.mark();
  alice.peer.send(MessageType.VOICE_AFK, { channelId: lobbyId });
  // The move itself goes only to who was moved and who asked; the room sees the arrival.
  await owner.peer.next(arrival(alice.sessionId, afkId), 'third AFK move', from);
  alice.peer.ws.terminate();
  await owner.peer.next(message => message.type === MessageType.USER_CONNECTION_STATE
    && record(message.payload).userId === alice.id && record(message.payload).status === 'reconnecting', 'dropped socket', from);
  const returning = await f.connect('Alice', alice.identity);
  const rejoined = await join(returning, afkId);
  assert.equal(rejoined.type, MessageType.VOICE_USER_JOINED, 'a dropped connection returns to the AFK room it was in');
  assert.equal(voiceState(rejoined).permissionMuted, true);

  const renamed = await owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { afkChannelName: 'Dormindo' });
  assert.equal(renamed.type, MessageType.SERVER_SETTINGS_UPDATED);
  const late = await f.connect('Late');
  assert.equal(late.details.afkChannelId, afkId);
  assert.equal(late.details.afkTimeoutSeconds, 300);
  assert.deepEqual(records(late.details.channels).filter(channel => channel.id === afkId || channel.name === 'Ausentes')
    .map(channel => channel.name), ['Dormindo'], 'the refused requests created no room and the rename applied');

  from = returning.peer.mark();
  const disabled = await owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { afkChannelEnabled: false });
  assert.equal(record(disabled.payload).afkChannelId, null);
  await returning.peer.next(message => message.type === MessageType.VOICE_USER_LEFT
    && record(message.payload).sessionId === alice.sessionId, 'eviction from the removed room', from);
  await returning.peer.next(message => message.type === MessageType.CHANNEL_DELETED
    && record(message.payload).channelId === afkId, 'removed room', from);
});
