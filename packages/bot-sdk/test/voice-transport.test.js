const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RTCPeerConnection, RTCRtpCodecParameters, RtpPacket } = require('werift');
const mediasoup = require('mediasoup');
const { OpusPeer, opusCodec } = require('../dist/voice/OpusPeer');
const { BotVoiceConnection } = require('../dist/voice/BotVoiceConnection');
const { MessageType } = require('@monky/shared');

// RFC 6716 comfort-noise/silence packet: synthetic, not recorded media.
const SILENCE = Uint8Array.from([0xf8, 0xff, 0xfe]);
const turn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let i = 0; i < 300 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'Condition did not become true');
}

async function rosterFixture(t, initialSessions = []) {
  const self = { user: { id: 'bot', sessionId: 'bot:one', isBot: true }, voiceState: { sessionId: 'bot:one', channelId: 'voice' } };
  const errors = [], departures = [], signals = [];
  const voice = new BotVoiceConnection('voice', {
    currentUser: self.user, server: { voiceMode: 'p2p' }, iceServers: [],
  }, {
    send(message) {
      if (message.type === MessageType.VOICE_JOIN) queueMicrotask(() => voice.handle({
        type: MessageType.VOICE_USER_JOINED, requestId: message.requestId,
        payload: { ...self, channelId: 'voice', sessionId: self.user.sessionId, participants: [self,
          ...initialSessions.map(sessionId => ({
            user: { id: sessionId, sessionId }, voiceState: { sessionId, channelId: 'voice' },
          })),
        ] },
      }));
      else if (message.type === MessageType.VOICE_LEAVE) queueMicrotask(() => voice.handle({
        type: MessageType.VOICE_USER_LEFT, requestId: message.requestId,
        payload: { channelId: 'voice', sessionId: self.user.sessionId },
      }));
      else signals.push(message);
    },
    participants() {}, disconnected(reason) { departures.push(reason); },
    error(error) { errors.push(error); },
  });
  t.after(() => voice.disconnect('test_finished'));
  const joining = voice.join();
  void joining.catch(() => {});
  if (!initialSessions.length) await joining;
  const arrive = (sessionId = 'aaa:human') => {
    voice.handle({ type: MessageType.VOICE_USER_JOINED, payload: {
      channelId: 'voice', sessionId, user: { id: sessionId, sessionId },
      voiceState: { channelId: 'voice', sessionId },
    } });
    return voice.peers.get(sessionId);
  };
  const leave = (sessionId = 'aaa:human') => voice.handle({
    type: MessageType.VOICE_USER_LEFT, payload: { channelId: 'voice', sessionId },
  });
  return { voice, joining, errors, departures, signals, arrive, leave };
}

async function receiveFrom(f, t, sessionId, withVideo = false) {
  const receiver = new RTCPeerConnection({ codecs: {
    audio: [opusCodec()], video: [new RTCRtpCodecParameters({ mimeType: 'video/VP8', clockRate: 90000 })],
  }, iceServers: [], bundlePolicy: 'max-bundle' });
  receiver.addTransceiver('audio', { direction: withVideo ? 'sendrecv' : 'recvonly' });
  if (withVideo) receiver.addTransceiver('video', { direction: 'sendrecv' });
  t.after(() => receiver.close());
  const packets = [];
  receiver.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => packets.push(packet)));
  const start = f.signals.length;
  await receiver.setLocalDescription(await receiver.createOffer());
  f.voice.handle({ type: MessageType.RTC_SIGNAL, payload: {
    fromSessionId: sessionId, targetSessionId: 'bot:one',
    signalType: 'offer', sdp: receiver.localDescription,
  } });
  const answer = () => f.signals.slice(start).find(message => message.payload?.targetSessionId === sessionId &&
    message.payload.signalType === 'answer');
  await until(() => answer());
  await receiver.setRemoteDescription(answer().payload.sdp);
  await f.voice.peers.get(sessionId).ready;
  return { receiver, packets };
}

for (const sessionId of ['aaa:human', 'zzz:human']) {
  test(`bot admission initiates toward existing ${sessionId} independently of ID ordering`, { timeout: 30000 }, async t => {
    const f = await rosterFixture(t, [sessionId]);
    const receiver = new RTCPeerConnection({ codecs: { audio: [opusCodec()] }, iceServers: [] });
    receiver.addTransceiver('audio', { direction: 'recvonly' });
    t.after(() => receiver.close());
    const packets = [];
    receiver.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => packets.push(packet)));
    const offer = () => f.signals.find(message => message.payload?.targetSessionId === sessionId &&
      message.payload.signalType === 'offer');
    await until(() => offer());
    await receiver.setRemoteDescription(offer().payload.sdp);
    await receiver.setLocalDescription(await receiver.createAnswer());
    f.voice.handle({ type: MessageType.RTC_SIGNAL, payload: {
      fromSessionId: sessionId, targetSessionId: 'bot:one',
      signalType: 'answer', sdp: receiver.localDescription,
    } });
    await f.joining;
    await f.voice.writeOpus(SILENCE);
    await until(() => packets.length === 1);
    assert.deepEqual(packets[0].payload, Buffer.from(SILENCE));
    assert.deepEqual(f.errors, []);
  });

  test(`arriving and rejoining ${sessionId} owns its audio/video offer without bot glare`, { timeout: 30000 }, async t => {
    const f = await rosterFixture(t);
    for (let round = 0; round < 2; round++) {
      const peer = f.arrive(sessionId);
      await peer.tasks;
      assert.equal(peer.pc.signalingState, 'stable', 'An existing participant must not compete with the arriving human.');
      const remote = await receiveFrom(f, t, sessionId, true);
      await f.voice.writeOpus(SILENCE);
      await until(() => remote.packets.length === 1);
      assert.deepEqual(remote.packets[0].payload, Buffer.from(SILENCE));
      assert.equal(f.signals.filter(message => message.payload?.signalType === 'offer').length, 0);
      f.leave(sessionId);
      await remote.receiver.close();
      assert.equal(peer.isClosed, true);
    }
    assert.equal(f.voice.isClosed, false);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.departures, []);
  });
}

test('late signaling and timeout callbacks from a retired peer cannot close its replacement', async t => {
  const f = await rosterFixture(t);
  const old = f.arrive();
  const gate = deferred();
  old.accept = () => gate.promise;
  f.voice.handle({ type: MessageType.RTC_SIGNAL, payload: {
    fromSessionId: 'aaa:human', targetSessionId: 'bot:one', signalType: 'candidate',
    candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  } });
  f.leave();
  const replacement = f.arrive();
  assert.notEqual(replacement, old);
  gate.reject(new Error('Retired ICE candidate operation failed.'));
  old.failed(new Error('Voice ICE/DTLS connection timed out.'));
  await turn();
  assert.equal(f.voice.isClosed, false);
  assert.equal(f.voice.peers.get('aaa:human'), replacement);
  assert.notEqual(replacement.pc.connectionState, 'closed');
  assert.deepEqual(f.departures, []);
  assert.deepEqual(f.errors, []);
});

test('retired peer cleanup errors are reported without disconnecting a newer transport', async t => {
  const f = await rosterFixture(t);
  const old = f.arrive();
  const gate = deferred();
  const close = old.close.bind(old);
  old.close = async () => { await close(); await gate.promise; };
  f.leave();
  const replacement = f.arrive();
  gate.reject(new Error('Retired UDP cleanup failed.'));
  await turn();
  assert.equal(f.voice.isClosed, false);
  assert.equal(f.voice.peers.get('aaa:human'), replacement);
  assert.deepEqual(f.departures, []);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /cleanup/i);
});

test('a newcomer timeout is isolated and real connected listeners keep receiving Opus', { timeout: 30000 }, async t => {
  const f = await rosterFixture(t);
  const receiver = new RTCPeerConnection({ codecs: { audio: [opusCodec()] }, iceServers: [] });
  receiver.addTransceiver('audio', { direction: 'recvonly' });
  t.after(() => receiver.close());
  const packets = [];
  receiver.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => packets.push(packet)));
  const listener = f.arrive('zzz:listener');
  await receiver.setLocalDescription(await receiver.createOffer());
  await listener.accept({
    fromSessionId: 'zzz:listener', targetSessionId: 'bot:one',
    signalType: 'offer', sdp: receiver.localDescription,
  }, true);
  const answer = f.signals.find(message => message.payload?.signalType === 'answer').payload.sdp;
  await receiver.setRemoteDescription(answer);
  await listener.ready;
  await f.voice.writeOpus(SILENCE);
  const newcomer = f.arrive('zzz:unreachable');
  newcomer.fail(new Error('Voice ICE/DTLS connection timed out.'));
  await turn();
  assert.equal(f.voice.isClosed, false);
  await f.voice.writeOpus(SILENCE);
  for (let i = 0; i < 100 && packets.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(packets.length, 2);
  assert.equal(newcomer.pc.connectionState, 'closed');
  assert.equal(f.errors.length, 1, 'A genuine current-peer failure must remain explicit.');
  assert.match(f.errors[0].message, /timed out/);
  assert.deepEqual(f.departures, []);
});

test('initial media readiness follows a same-session leave/rejoin instead of the retired snapshot', { timeout: 30000 }, async t => {
  t.mock.method(OpusPeer.prototype, 'offer', async () => {});
  const f = await rosterFixture(t, ['aaa:human']);
  await until(() => f.voice.peers.has('aaa:human'));
  const old = f.voice.peers.get('aaa:human');
  let joined = false;
  void f.joining.then(() => { joined = true; }, () => {});
  f.leave();
  const replacement = f.arrive();
  await turn();
  assert.notEqual(old, replacement);
  assert.equal(joined, false, 'Roster appearance is not replacement media readiness.');
  const remote = await receiveFrom(f, t, 'aaa:human');
  await f.joining;
  await f.voice.writeOpus(SILENCE);
  await until(() => remote.packets.length === 1);
  assert.equal(joined, true);
  assert.deepEqual(f.errors, []);
});

test('an in-flight RTP rejection from a departed listener does not fail playback for its replacement', { timeout: 30000 }, async t => {
  const f = await rosterFixture(t);
  const old = f.arrive('zzz:human');
  await receiveFrom(f, t, 'zzz:human');
  const gate = deferred();
  old.write = () => gate.promise;
  const writing = f.voice.writeOpus(SILENCE);
  f.leave('zzz:human');
  f.arrive('zzz:human');
  gate.reject(new Error('Retired SRTP transport closed during send.'));
  await writing;
  const next = await receiveFrom(f, t, 'zzz:human');
  await f.voice.writeOpus(SILENCE);
  await until(() => next.packets.length === 1);
  assert.equal(f.voice.isClosed, false);
  assert.deepEqual(f.errors, []);
});

test('a fresh remote offer recovers a failed listener and delivers real Opus without rejoining the room', { timeout: 30000 }, async t => {
  const f = await rosterFixture(t);
  const old = f.arrive('zzz:human');
  const first = await receiveFrom(f, t, 'zzz:human');
  await f.voice.writeOpus(SILENCE);
  await until(() => first.packets.length === 1);
  old.fail(new Error('Voice transport failed.'));
  await turn();
  assert.equal(f.voice.isClosed, false);
  f.voice.handle({ type: MessageType.RTC_SIGNAL, payload: {
    fromSessionId: 'zzz:human', targetSessionId: 'bot:one', signalType: 'candidate',
    candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  } });
  assert.equal(f.voice.peers.get('zzz:human'), old, 'A late candidate must not start a new transport.');
  const second = await receiveFrom(f, t, 'zzz:human');
  assert.notEqual(f.voice.peers.get('zzz:human'), old);
  await f.voice.writeOpus(SILENCE);
  await until(() => second.packets.length === 1);
  assert.equal(f.errors.length, 1, 'Report the real failure once, not the retired candidate.');
  assert.deepEqual(f.departures, []);
});

test('a genuine RTP write failure remains explicit rather than pretending to advance successfully', { timeout: 30000 }, async t => {
  const f = await rosterFixture(t);
  const peer = f.arrive('zzz:human');
  await receiveFrom(f, t, 'zzz:human');
  peer.write = async () => { throw new Error('Current SRTP send failed.'); };
  await assert.rejects(f.voice.writeOpus(SILENCE), /Current SRTP send failed/);
  assert.equal(f.errors.length, 1);
  assert.equal(peer.isClosed, true);
});

test('leaving waits for outstanding retired-peer cleanup before reporting disconnection', async t => {
  const f = await rosterFixture(t);
  const old = f.arrive();
  const gate = deferred();
  const close = old.close.bind(old);
  old.close = async () => { await close(); await gate.promise; };
  f.leave();
  let closed = false;
  const leaving = f.voice.close().then(() => { closed = true; });
  try {
    await turn();
    assert.equal(closed, false);
    assert.deepEqual(f.departures, []);
  } finally { gate.resolve(); await leaving; }
  assert.equal(closed, true);
  assert.deepEqual(f.departures, ['left']);
});

test('ICE/DTLS readiness timeout rejects explicitly once and closes the peer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = [];
  const peer = new OpusPeer([], (error) => errors.push(error));
  const rejection = assert.rejects(peer.ready, /timed out/);
  t.mock.timers.tick(20001);
  await rejection;
  assert.equal(errors.length, 1);
  await peer.close();
  assert.equal(peer.pc.connectionState, 'closed');
});

test('browser-shaped audio/video offers preserve bot microphone and decline other media', { timeout: 30000 }, async () => {
  const errors = [];
  let answer;
  const bot = new OpusPeer([], (error) => errors.push(error), (signal) => { answer = signal.sdp; });
  const human = new RTCPeerConnection({
    iceServers: [], bundlePolicy: 'max-bundle', codecs: { audio: [opusCodec()], video: [
      new RTCRtpCodecParameters({ mimeType: 'video/VP8', clockRate: 90000 }),
    ] },
  });
  human.addTransceiver('audio', { direction: 'sendrecv' });
  human.addTransceiver('video', { direction: 'sendrecv' });
  try {
    let received;
    const packet = new Promise((resolve) => { received = resolve; });
    human.onTrack.subscribe((track) => track.onReceiveRtp.subscribe(received));
    await human.setLocalDescription(await human.createOffer());
    await bot.accept({
      fromSessionId: 'human', targetSessionId: 'bot', signalType: 'offer', sdp: human.localDescription,
    }, true);
    assert.ok(answer);
    assert.match(answer.sdp.split('m=video')[1], /a=inactive/);
    assert.deepEqual(bot.pc.getTransceivers().map((entry) => entry.direction), ['sendonly', 'inactive']);
    await human.setRemoteDescription(answer);
    await bot.ready;
    await bot.write(SILENCE);
    assert.deepEqual((await packet).payload, Buffer.from(SILENCE));
    assert.deepEqual(errors, []);
  } finally { await bot.close(); await human.close(); }
});

test('real P2P ICE/DTLS/SRTP delivers timed Opus packets to a receiving peer', { timeout: 30000 }, async () => {
  const errors = [];
  const sender = new OpusPeer([], (error) => errors.push(error));
  const receiver = new RTCPeerConnection({ codecs: { audio: [opusCodec()] }, iceServers: [] });
  try {
    const packets = [];
    let delivered;
    const received = new Promise((resolve) => { delivered = resolve; });
    receiver.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((packet) => {
      packets.push(packet);
      if (packets.length === 3) delivered();
    }));
    await sender.pc.setLocalDescription(await sender.pc.createOffer());
    await receiver.setRemoteDescription(sender.pc.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.pc.setRemoteDescription(receiver.localDescription);
    await sender.ready;
    for (let i = 0; i < 3; i++) await sender.write(SILENCE);
    await received;
    for (const packet of packets) assert.deepEqual(packet.payload, Buffer.from(SILENCE));
    assert.equal((packets[1].header.timestamp - packets[0].header.timestamp) >>> 0, 960);
    assert.equal((packets[2].header.sequenceNumber - packets[1].header.sequenceNumber) & 65535, 1);
    assert.deepEqual(errors, []);
  } finally { await sender.close(); await receiver.close(); }
});

test('real mediasoup WebRtcTransport receives and forwards bot Opus over ICE/DTLS/SRTP', { timeout: 30000 }, async () => {
  const errors = [];
  const sender = new OpusPeer([], (error) => errors.push(error));
  const worker = await mediasoup.createWorker({ logLevel: 'error' });
  try {
    const router = await worker.createRouter({ mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    ] });
    const transport = await router.createWebRtcTransport({
      listenInfos: [{ protocol: 'udp', ip: '127.0.0.1' }],
    });

    const options = {
      id: transport.id, iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters,
    };
    const { dtlsParameters, rtpParameters, answer } = await sender.prepareSfu(options);
    await transport.connect({ dtlsParameters });
    await sender.pc.setRemoteDescription({ type: 'answer', sdp: answer });
    await sender.ready;
    const producer = await transport.produce({ kind: 'audio', rtpParameters, appData: { mediaType: 'mic' } });
    const output = await router.createDirectTransport();
    const consumer = await output.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities });
    const packets = [];
    let delivered;
    const received = new Promise((resolve) => { delivered = resolve; });
    consumer.on('rtp', (bytes) => {
      packets.push(RtpPacket.deSerialize(bytes));
      if (packets.length === 3) delivered();
    });
    for (let i = 0; i < 3; i++) await sender.write(SILENCE);
    await received;
    for (const packet of packets) assert.deepEqual(packet.payload, Buffer.from(SILENCE));
    assert.equal((packets[1].header.timestamp - packets[0].header.timestamp) >>> 0, 960);
    const stats = await producer.getStats();
    assert.ok(stats.some((entry) => entry.packetCount >= 3), 'mediasoup must have received RTP, not only signaling');
    assert.deepEqual(errors, []);
  } finally { await sender.close(); worker.close(); }
});

test('SFU voice connection validates real wire metadata and completes the existing SFU request flow', { timeout: 30000 }, async () => {
  const worker = await mediasoup.createWorker({ logLevel: 'error' });
  const errors = [];
  let transport;
  let received;
  const delivered = new Promise((resolve) => { received = resolve; });
  const router = await worker.createRouter({ mediaCodecs: [
    { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  ] });
  const requests = [];
  const activity = [];
  let signaling = Promise.resolve();
  const voice = new BotVoiceConnection('voice', {
    currentUser: { id: 'bot', sessionId: 'bot:one' }, server: { voiceMode: 'sfu' }, iceServers: [],
  }, {
    send(message) {
      requests.push(message.type);
      signaling = signaling.then(async () => {
        const reply = (type, payload) => voice.handle({ type, payload, requestId: message.requestId });
        switch (message.type) {
          case MessageType.VOICE_JOIN:
            reply(MessageType.VOICE_USER_JOINED, {
              channelId: 'voice', sessionId: 'bot:one', user: { id: 'bot', isBot: true },
              voiceState: { sessionId: 'bot:one', channelId: 'voice' }, participants: [],
            });
            break;
          case MessageType.SFU_CREATE_WEBRTC_TRANSPORT:
            transport = await router.createWebRtcTransport({ listenInfos: [{ protocol: 'udp', ip: '127.0.0.1' }] });
            reply(MessageType.SFU_WEBRTC_TRANSPORT_CREATED, {
              transportOptions: {
                id: transport.id, iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters,
              },
            });
            break;
          case MessageType.SFU_CONNECT_WEBRTC_TRANSPORT:
            await transport.connect({ dtlsParameters: message.payload.dtlsParameters });
            reply(MessageType.SFU_WEBRTC_TRANSPORT_CONNECTED, {});
            break;
          case MessageType.SFU_PRODUCE: {
            assert.deepEqual(message.payload.appData, { mediaType: 'mic' });
            const producer = await transport.produce(message.payload);
            const output = await router.createDirectTransport();
            const consumer = await output.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities });
            consumer.on('rtp', (bytes) => received(RtpPacket.deSerialize(bytes)));
            reply(MessageType.SFU_PRODUCED, { id: producer.id });
            break;
          }
          case MessageType.VOICE_LEAVE:
            transport?.close();
            reply(MessageType.VOICE_USER_LEFT, { channelId: 'voice', sessionId: 'bot:one' });
            break;
          case MessageType.VOICE_STATE_UPDATE:
            activity.push(message.payload);
            break;
          default: assert.fail(`Unexpected message ${message.type}`);
        }
      }).catch((error) => {
        errors.push(error);
        voice.handle({ type: MessageType.SERVER_ERROR, requestId: message.requestId, payload: { message: error.message } });
      });
    },
    participants() {}, disconnected() {}, error(error) { errors.push(error); },
  });
  try {
    await voice.join();
    await voice.writeOpus(SILENCE);
    assert.deepEqual((await delivered).payload, Buffer.from(SILENCE));
    await voice.close();
    assert.equal(transport.closed, true);
    assert.deepEqual(requests, [
      MessageType.VOICE_JOIN, MessageType.SFU_CREATE_WEBRTC_TRANSPORT,
      MessageType.SFU_CONNECT_WEBRTC_TRANSPORT, MessageType.SFU_PRODUCE,
      MessageType.VOICE_STATE_UPDATE, MessageType.VOICE_STATE_UPDATE, MessageType.VOICE_LEAVE,
    ]);
    assert.deepEqual(activity, [{ isSpeaking: true }, { isSpeaking: false }]);
    assert.deepEqual(errors, []);
  } finally { await voice.disconnect('test_finished'); worker.close(); await signaling; }
});
