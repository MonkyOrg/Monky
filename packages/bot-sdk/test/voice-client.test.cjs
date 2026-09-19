const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { RTCPeerConnection } = require('werift');
const { BotClient, MessageType } = require('../dist');
const { rtcSignalSchema } = require('@monky/shared');
const { opusCodec } = require('../dist/voice/OpusPeer');
const { BotVoiceConnection, validateOpus } = require('../dist/voice/BotVoiceConnection');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await wait(10);
  assert.ok(predicate(), 'Condition did not become true');
}

const SILENCE = Uint8Array.from([0xf8, 0xff, 0xfe]);
const self = { user: { id: 'bot', sessionId: 'bot:one', isBot: true }, voiceState: { sessionId: 'bot:one', channelId: 'voice' } };
const human = { user: { id: 'human', sessionId: 'aaa:human' }, voiceState: { sessionId: 'aaa:human', channelId: 'voice' } };

test('text-only BotClient does not load the WebRTC transport dependency', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const { BotClient } = require('./dist');
    const bot = new BotClient({ publicKey: 'a'.repeat(64), requestedCapabilities: ['publish_voice'] });
    if (require.cache[require.resolve('werift')]) throw new Error('WebRTC was loaded eagerly');
    bot.close().catch((error) => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

async function fixture(t, withHuman = false) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let socket;
  let joins = 0;
  const joinPayloads = [];
  const voiceUpdates = [];
  const rtcSignals = [];
  const remote = new RTCPeerConnection({ codecs: { audio: [opusCodec()] }, iceServers: [] });
  const packets = [];
  let received;
  const delivered = new Promise((resolve) => { received = resolve; });
  remote.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((packet) => {
    packets.push(packet); received();
  }));
  let signaling = Promise.resolve();
  const errors = [];
  server.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (bytes) => {
      const msg = JSON.parse(bytes.toString());
      if (msg.type === MessageType.AUTH_CONNECT) {
        send(MessageType.AUTH_SUCCESS, { currentUser: self.user, server: { voiceMode: 'p2p' }, iceServers: [] });
      } else if (msg.type === MessageType.VOICE_JOIN) {
        joins++;
        joinPayloads.push(msg.payload);
        send(MessageType.VOICE_USER_JOINED, {
          channelId: 'voice', sessionId: self.voiceState.sessionId, ...self,
          participants: withHuman ? [self, human] : [self],
        }, msg.requestId);
      } else if (msg.type === MessageType.VOICE_LEAVE) {
        send(MessageType.VOICE_USER_LEFT, { channelId: 'voice', sessionId: self.voiceState.sessionId }, msg.requestId);
      } else if (msg.type === MessageType.VOICE_STATE_UPDATE) {
        voiceUpdates.push(msg.payload);
      } else if (msg.type === MessageType.RTC_SIGNAL && msg.payload.signalType === 'offer') {
        rtcSignals.push(msg.payload);
        signaling = signaling.then(async () => {
          await remote.setRemoteDescription(msg.payload.sdp);
          await remote.setLocalDescription(await remote.createAnswer());
          send(MessageType.RTC_SIGNAL, {
            fromSessionId: human.voiceState.sessionId, targetSessionId: self.voiceState.sessionId,
            signalType: 'answer', subscriptionId: 'human-peer-epoch', sdp: remote.localDescription,
          });
        }).catch((error) => errors.push(error));
      }
    });
  });
  function send(type, payload, requestId) { socket.send(JSON.stringify({ type, payload, requestId })); }
  const bot = new BotClient({ publicKey: 'a'.repeat(64), requestedCapabilities: ['commands', 'publish_voice'], token: 'token', serverUrl: `ws://127.0.0.1:${server.address().port}`, autoReconnect: false });
  bot.on('error', (error) => errors.push(error));
  const connected = once(bot, 'connected');
  bot.connect({ serverId: 'server' });
  await connected;
  t.after(async () => {
    await bot.close();
    await remote.close();
    await signaling;
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { bot, send, packets, delivered, errors, joinPayloads, voiceUpdates, rtcSignals, joins: () => joins, remote, disconnect: () => socket.close() };
}

test('invocation voice join options travel only with their admission request', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.bot.joinVoice('server', 'voice', { invocationId: '' }), /Invalid voice join options/);
  await assert.rejects(f.bot.joinVoice('server', 'voice', { sessionId: 'forged' }), /Invalid voice join options/);
  await f.bot.joinVoice('server', 'voice', { invocationId: 'command-invocation' });
  assert.equal(f.joinPayloads[0].invocationId, 'command-invocation');
  assert.equal(f.joinPayloads[0].isMuted, false);
  assert.equal(f.joinPayloads[0].isDeafened, false);
  assert.deepEqual(f.voiceUpdates, []);
  await f.bot.leaveVoice('server');
  await f.bot.joinVoice('server', 'voice');
  assert.equal(f.joinPayloads[1].invocationId, undefined);
  assert.deepEqual(f.errors, []);
});

test('BotClient joins once, preserves transport on roster changes, sends real Opus and leaves cleanly', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, true);
  const first = f.bot.joinVoice('server', 'voice');
  const second = f.bot.joinVoice('server', 'voice');
  assert.equal(first, second);
  const voice = await first;
  assert.equal(f.rtcSignals.length, 1);
  assert.equal(rtcSignalSchema.safeParse(f.rtcSignals[0]).success, true);
  assert.match(f.rtcSignals[0].subscriptionId, /^[a-f0-9-]{36}$/);
  assert.equal(f.joins(), 1);
  assert.equal(voice.humanParticipantCount, 1);
  await assert.rejects(f.bot.joinVoice('server', 'other'), /Leave/);
  f.send(MessageType.VOICE_USER_JOINED, { ...human, channelId: 'voice', sessionId: human.voiceState.sessionId });
  await voice.writeOpus(SILENCE);
  await f.delivered;
  assert.deepEqual(f.packets[0].payload, Buffer.from(SILENCE));
  await until(() => f.voiceUpdates.length === 1);
  assert.deepEqual(f.voiceUpdates, [{ isSpeaking: true }]);
  assert.equal(voice.peers.get(human.user.sessionId).pc.getTransceivers()[0].direction, 'sendonly');
  assert.equal(f.bot.getVoiceConnection('server'), voice);
  const changed = once(f.bot, 'voiceParticipantsChanged');
  f.send(MessageType.VOICE_USER_LEFT, { channelId: 'voice', sessionId: human.voiceState.sessionId });
  assert.equal((await changed)[0].humanParticipantCount, 0);
  await until(() => f.voiceUpdates.length === 2);
  assert.deepEqual(f.voiceUpdates[1], { isSpeaking: false });
  assert.equal(f.bot.getVoiceConnection('server'), voice);
  const left = once(f.bot, 'voiceDisconnected');
  await f.bot.leaveVoice('server');
  assert.equal((await left)[0].reason, 'left');
  await assert.rejects(voice.writeOpus(SILENCE), /not active/);
  assert.equal(f.bot.getVoiceConnection('server'), undefined);
  assert.deepEqual(f.errors, []);
});

test('voice closes UDP resources on mode change and signaling disconnect', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await f.bot.joinVoice('server', 'voice');
  const changed = once(f.bot, 'voiceDisconnected');
  f.send(MessageType.SERVER_SETTINGS_UPDATED, { voiceMode: 'sfu' });
  assert.equal((await changed)[0].reason, 'mode_changed');
  assert.equal(f.bot.getVoiceConnection('server'), undefined);
  f.send(MessageType.SERVER_SETTINGS_UPDATED, { voiceMode: 'p2p' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const voice = await f.bot.joinVoice('server', 'voice');
  const disconnected = once(f.bot, 'voiceDisconnected');
  f.disconnect();
  assert.equal((await disconnected)[0].reason, 'disconnected');
  await assert.rejects(voice.writeOpus(SILENCE), /not active/);
});

test('Opus API rejects PCM, oversized and non-20ms packets', () => {
  validateOpus(SILENCE);
  assert.throws(() => validateOpus(Buffer.alloc(0)), /raw Opus/);
  assert.throws(() => validateOpus(Buffer.alloc(1276)), /raw Opus/);
  assert.throws(() => validateOpus(Uint8Array.from([0x80, 0])), /20 ms/);
  assert.throws(() => validateOpus(Uint8Array.from([0xfb])), /20 ms/);
});

test('bot audio obeys identity mute/deafen restrictions and closes after a voice kick', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, true);
  const voice = await f.bot.joinVoice('server', 'voice');
  for (const restriction of [{ serverMuted: true, serverDeafened: false }, { serverMuted: false, serverDeafened: true }]) {
    voice.handle({ type: MessageType.VOICE_STATE_CHANGED, payload: { voiceState: { ...self.voiceState, ...restriction } } });
    await voice.writeOpus(SILENCE);
    await assert.rejects(voice.writeOpus(Uint8Array.of(0x80, 0)), /20 ms/);
    await assert.rejects(voice.writeOpus(new Uint8Array(0)), /raw Opus/);
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(f.packets.length, 0);
  voice.handle({ type: MessageType.VOICE_STATE_CHANGED, payload: {
    voiceState: { ...self.voiceState, serverMuted: false, serverDeafened: false },
  } });
  await voice.writeOpus(SILENCE);
  await f.delivered;
  assert.equal(f.packets.length, 1);
  const disconnected = once(f.bot, 'voiceDisconnected');
  f.send(MessageType.ADMIN_KICK_VOICE, { targetSessionId: self.voiceState.sessionId });
  f.send(MessageType.VOICE_USER_LEFT, { channelId: 'voice', sessionId: self.voiceState.sessionId });
  await disconnected;
  await assert.rejects(voice.writeOpus(SILENCE), /not active/);
  assert.equal(f.bot.getVoiceConnection('server'), undefined);
  assert.deepEqual(f.errors, []);
});

test('unrelated administrative arrivals do not invalidate an active bot voice transport', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, true);
  const voice = await f.bot.joinVoice('server', 'voice');
  voice.handle({
    type: MessageType.VOICE_USER_JOINED,
    payload: { channelId: 'other-room', sessionId: 'other-human', voiceState: { channelId: 'other-room', sessionId: 'other-human' } },
  });
  assert.equal(voice.isClosed, false);
  assert.equal(voice.humanParticipantCount, 1);
  await voice.writeOpus(SILENCE);
  await f.delivered;
  assert.deepEqual(f.errors, []);
});

test('an administrative move leaves the destination rather than stranding a silent bot', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const voice = await f.bot.joinVoice('server', 'voice');
  const disconnected = once(f.bot, 'voiceDisconnected');
  f.send(MessageType.ADMIN_MOVE_USER, { targetSessionId: self.voiceState.sessionId, channelId: 'destination' });
  assert.equal((await disconnected)[0].reason, 'moved');
  assert.equal(voice.isClosed, true);
  assert.equal(f.bot.getVoiceConnection('server'), undefined);
  assert.deepEqual(f.errors, []);
});

test('empty voice notifications count human sessions only, even while other bots stay', async () => {
  const counts = [];
  const voice = new BotVoiceConnection('voice', {
    currentUser: self.user, server: { voiceMode: 'p2p' }, iceServers: [],
  }, {
    send() { assert.fail('Roster-only updates must not open transports before admission.'); },
    participants(count) { counts.push(count); }, disconnected() {},
    error(error) { assert.fail(error.message); },
  });
  const join = (id, isBot, userId = id) => voice.handle({
    type: MessageType.VOICE_USER_JOINED, payload: {
      sessionId: id, channelId: 'voice', user: { id: userId, sessionId: id, isBot },
      voiceState: { sessionId: id, channelId: 'voice' },
    },
  });
  const leave = (sessionId) => voice.handle({
    type: MessageType.VOICE_USER_LEFT, payload: { sessionId, channelId: 'voice' },
  });
  join(self.user.sessionId, true);
  join('bot:other', true);
  join('human:device-one', false, 'same-human');
  join('human:device-two', false, 'same-human');
  join('human:device-two', false, 'same-human');
  leave('human:device-one');
  leave('human:device-two');
  assert.deepEqual(counts, [1, 2, 1, 0]);
  assert.equal(voice.humanParticipantCount, 0);
  await voice.disconnect('test_finished');
});
