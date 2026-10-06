const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } = require('werift');
const mediasoup = require('mediasoup');
const { MessageType } = require('@monky/shared');
const { OpusPeer, opusCodec } = require('../dist/voice/OpusPeer');
const { BotVoiceConnection } = require('../dist/voice/BotVoiceConnection');
const { VoiceAudioReceiver, MAX_BUFFERED_VOICE_PACKETS } = require('../dist/voice/VoiceAudioReceiver');

const SILENCE = Uint8Array.from([0xf8, 0xff, 0xfe]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message = 'Condition did not become true') {
  for (let i = 0; i < 500 && !predicate(); i++) await wait(10);
  assert.ok(predicate(), message);
}
const participant = (id, isBot = false) => ({
  user: { id, sessionId: `${isBot ? 'bot' : 'human'}:${id}`, isBot },
  voiceState: { sessionId: `${isBot ? 'bot' : 'human'}:${id}`, channelId: 'room',
    isMuted: false, isDeafened: false, serverMuted: false, serverDeafened: false },
});

test('live receiver has bounded backpressure, one pending read, cancellation and no retained audio', async () => {
  let stops = 0;
  const errors = [];
  const signal = new AbortController();
  const receiver = new VoiceAudioReceiver(async () => { stops++; }, error => errors.push(error), signal.signal);
  for (let i = 0; i < MAX_BUFFERED_VOICE_PACKETS + 7; i++) receiver.push({ sequenceNumber: i, sessionId: 'one' });
  assert.equal(receiver.droppedPackets, 7);
  assert.equal((await receiver.next()).value.sequenceNumber, 7);
  receiver.clear('one');
  const waiting = receiver.next();
  await assert.rejects(receiver.next(), /previous audio packet/);
  signal.abort();
  assert.equal((await waiting).done, true);
  await receiver.return();
  assert.equal(stops, 1);
  assert.equal(receiver.queue.length, 0);
  assert.deepEqual(errors, []);
});

test('aborted iteration waits for reception shutdown and propagates shutdown errors', async () => {
  let release;
  const stopping = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const errors = [];
  const receiver = new VoiceAudioReceiver(() => stopping, error => errors.push(error), controller.signal);
  let ended = false;
  const pending = receiver.next().then(result => { ended = true; return result; });
  controller.abort();
  receiver.push({ sessionId: 'late', sequenceNumber: 1 });
  await Promise.resolve();
  assert.equal(ended, false);
  assert.equal(receiver.queue.length, 0);
  release();
  assert.equal((await pending).done, true);
  await receiver.return();
  const failed = new VoiceAudioReceiver(async () => { throw new Error('shutdown failed'); }, error => errors.push(error));
  const read = assert.rejects(failed.next(), /shutdown failed/);
  await assert.rejects(failed.return(), /shutdown failed/);
  await read;
  assert.deepEqual(errors, []);
});
async function p2pFixture(t, { receive = true, publish = true } = {}) {
  const self = participant('listener', true);
  const humans = [participant('one'), participant('two')];
  const errors = [], updates = [], peers = new Map(), jobs = new Set();
  let voice;
  const run = operation => {
    const job = Promise.resolve().then(operation).catch(error => errors.push(error)).finally(() => jobs.delete(job));
    jobs.add(job);
  };
  for (const human of humans) {
    const pc = new RTCPeerConnection({ codecs: { audio: [opusCodec()] }, iceServers: [], bundlePolicy: 'max-bundle' });
    const track = new MediaStreamTrack({ kind: 'audio' });
    const sender = pc.addTrack(track);
    const heard = [];
    pc.onTrack.subscribe(remote => remote.onReceiveRtp.subscribe(packet => heard.push(packet)));
    peers.set(human.user.sessionId, { pc, sender, heard, track, sequence: 0 });
  }
  voice = new BotVoiceConnection('room', { currentUser: self.user, server: { voiceMode: 'p2p' }, iceServers: [] }, {
    send(message) {
      run(async () => {
        let type, payload;
        if (message.type === MessageType.VOICE_JOIN) {
          self.voiceState.receivesVoice = message.payload.receiveAudio === true;
          type = MessageType.VOICE_USER_JOINED;
          payload = { ...self, channelId: 'room', sessionId: self.user.sessionId, participants: [self, ...humans] };
        } else if (message.type === MessageType.VOICE_STATE_UPDATE) {
          updates.push(message.payload);
          self.voiceState = { ...self.voiceState, ...message.payload };
          type = MessageType.VOICE_STATE_CHANGED;
          payload = { voiceState: self.voiceState };
        } else if (message.type === MessageType.VOICE_LEAVE) {
          type = MessageType.VOICE_USER_LEFT;
          payload = { channelId: 'room', sessionId: self.user.sessionId };
        } else if (message.type === MessageType.RTC_SIGNAL && message.payload.signalType === 'offer') {
          const remote = peers.get(message.payload.targetSessionId);
          await remote.pc.setRemoteDescription(message.payload.sdp);
          await remote.pc.setLocalDescription(await remote.pc.createAnswer());
          type = MessageType.RTC_SIGNAL;
          payload = { fromSessionId: message.payload.targetSessionId, targetSessionId: self.user.sessionId,
            signalType: 'answer', sdp: remote.pc.localDescription };
        } else return;
        voice.handle({ type, payload: structuredClone(payload), requestId: message.requestId });
      });
    },
    participants() {}, disconnected() {}, error(error) { errors.push(error); },
  }, publish);
  t.after(async () => {
    await voice.disconnect('test_finished');
    await Promise.allSettled(jobs);
    await Promise.all([...peers.values()].map(async remote => { remote.track.stop(); await remote.pc.close(); }));
  });
  await voice.join({ receiveAudio: receive });
  const send = async (index, frame = SILENCE) => {
    const remote = peers.get(humans[index].user.sessionId);
    await until(() => remote.pc.connectionState === 'connected' && remote.pc.signalingState === 'stable');
    await remote.sender.sendRtp(new RtpPacket(new RtpHeader({
      payloadType: 111, sequenceNumber: ++remote.sequence, timestamp: remote.sequence * 960, ssrc: remote.sender.ssrc,
    }), Buffer.from(frame)));
  };
  return { voice, send, humans, self, peers, errors, updates, jobs };
}

test('P2P receives simultaneous microphones with source identity, duplex audio and independent mute/deafen', { timeout: 30000 }, async t => {
  const f = await p2pFixture(t);
  const receiver = f.voice.receiveAudio();
  assert.throws(() => f.voice.receiveAudio(), /Only one/);
  await Promise.all([f.send(0), f.send(1)]);
  const packets = [(await receiver.next()).value, (await receiver.next()).value];
  assert.deepEqual(new Set(packets.map(packet => packet.userId)), new Set(['one', 'two']));
  for (const packet of packets) {
    assert.equal(packet.sessionId, `human:${packet.userId}`);
    assert.equal(packet.channelId, 'room');
    assert.equal(packet.codec, 'opus');
    assert.equal(packet.clockRate, 48000);
    assert.equal(packet.timestamp, 960);
    assert.equal(packet.sequenceNumber, 1);
    assert.ok(packet.receivedAt > 0);
    assert.deepEqual(packet.opus, SILENCE);
  }
  await f.voice.writeOpus(SILENCE);
  await until(() => [...f.peers.values()].every(remote => remote.heard.length === 1));
  await f.voice.setMuted(true);
  await f.send(0, Uint8Array.from([0xf0, 0xff, 0xfe]));
  assert.deepEqual((await receiver.next()).value.opus, Uint8Array.from([0xf0, 0xff, 0xfe]),
    'Receive accepts durations other than the outbound 20 ms contract');
  await f.voice.writeOpus(SILENCE);
  await wait(50);
  assert.ok([...f.peers.values()].every(remote => remote.heard.length === 1));
  await f.voice.setMuted(false);
  f.voice.handle({ type: MessageType.VOICE_STATE_CHANGED, payload: {
    voiceState: { ...f.humans[0].voiceState, serverMuted: true },
  } });
  await f.send(0);
  await f.send(1);
  assert.equal((await receiver.next()).value.userId, 'two', 'A muted source is not handed to the application');
  await f.voice.setDeafened(true);
  assert.equal(f.voice.isReceivingAudio, false);
  assert.equal(receiver.queue.length, 0);
  await f.voice.setDeafened(false);
  await until(() => [...f.voice.peers.values()].every(peer => peer.pc.signalingState === 'stable'));
  await f.send(1);
  assert.equal((await receiver.next()).value.userId, 'two');
  const pending = receiver.next();
  await f.voice.close();
  assert.equal((await pending).done, true);
  assert.equal(receiver.queue.length, 0);
  assert.deepEqual(f.errors, []);
});

test('P2P listening is opt-in; a listener without publishing permission cannot transmit', { timeout: 30000 }, async t => {
  for (const receive of [false, true]) {
    const f = await p2pFixture(t, { receive, publish: !receive });
    if (!receive) {
      assert.throws(() => f.voice.receiveAudio(), /receiveAudio: true/);
      assert.equal(f.voice.isReceivingAudio, false);
      assert.ok([...f.voice.peers.values()].every(peer => peer.pc.getTransceivers()[0].direction === 'sendonly'));
    } else {
      const abort = new AbortController();
      const receiver = f.voice.receiveAudio({ signal: abort.signal });
      await assert.rejects(f.voice.writeOpus(SILENCE), /receive-only/);
      await f.send(0);
      assert.equal((await receiver.next()).value.userId, 'one');
      abort.abort();
      await until(() => f.self.voiceState.isDeafened && !f.voice.audioReceiver);
      assert.equal((await receiver.next()).done, true);
      assert.equal(f.voice.isClosed, false, 'Canceling reception does not leave the voice room');
    }
    await f.voice.close();
    assert.deepEqual(f.errors, []);
  }
});

test('deafen during initial SFU allocation cancels reception without failing voice admission', async t => {
  const self = participant('listener', true);
  let pending;
  const errors = [];
  const voice = new BotVoiceConnection('room', { currentUser: self.user, server: { voiceMode: 'sfu' }, iceServers: [] }, {
    send(message) {
      if (message.type === MessageType.VOICE_JOIN) queueMicrotask(() => voice.handle({
        type: MessageType.VOICE_USER_JOINED, requestId: message.requestId,
        payload: { ...self, voiceState: { ...self.voiceState, receivesVoice: true },
          channelId: 'room', sessionId: self.user.sessionId, participants: [self] },
      }));
      else if (message.type === MessageType.SFU_CREATE_WEBRTC_TRANSPORT) pending = message;
      else if (message.type === MessageType.VOICE_LEAVE) queueMicrotask(() => voice.handle({
        type: MessageType.VOICE_USER_LEFT, requestId: message.requestId,
        payload: { channelId: 'room', sessionId: self.user.sessionId },
      }));
      else throw new Error(`Unexpected request ${message.type}`);
    },
    participants() {}, disconnected() {}, error(error) { errors.push(error); },
  }, false);
  t.after(() => voice.disconnect('test_finished'));
  const joining = voice.join({ receiveAudio: true });
  await until(() => !!pending);
  voice.handle({ type: MessageType.VOICE_STATE_CHANGED, payload: {
    voiceState: { ...self.voiceState, receivesVoice: true, serverDeafened: true },
  } });
  voice.handle({ type: MessageType.SERVER_ERROR, requestId: pending.requestId,
    payload: { message: 'Voice reception changed during transport allocation.' } });
  await joining;
  assert.equal(voice.isClosed, false);
  assert.equal(voice.isReceivingAudio, false);
  assert.equal(voice.pending.size, 0);
  assert.deepEqual(errors, []);
  await voice.close();
});

test('SFU receives two real Opus producers, handles removal/rejoin and rebuilds only reception after deafen', { timeout: 45000 }, async t => {
  const worker = await mediasoup.createWorker({ logLevel: 'error' });
  const router = await worker.createRouter({ mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }] });
  const transports = new Map(), producers = new Map(), sources = [], errors = [], jobs = new Set();
  const self = participant('listener', true);
  const humans = [participant('one'), participant('two')];
  let voice;
  const createTransport = async () => {
    const transport = await router.createWebRtcTransport({ listenInfos: [{ protocol: 'udp', ip: '127.0.0.1' }] });
    transports.set(transport.id, transport);
    return transport;
  };
  const options = transport => ({
    id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters,
  });
  async function makeSource(human, previous) {
    const peer = previous?.peer ?? new OpusPeer([], error => errors.push(error));
    if (!previous) sources.push(peer);
    const transport = previous?.transport ?? await createTransport();
    let rtpParameters = previous?.rtpParameters;
    if (!previous) {
      const prepared = await peer.prepareSfu(options(transport));
      rtpParameters = prepared.rtpParameters;
      await transport.connect({ dtlsParameters: prepared.dtlsParameters });
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: prepared.answer });
      await peer.ready;
    }
    const producer = await transport.produce({ kind: 'audio', rtpParameters, appData: { mediaType: 'mic' } });
    const metadata = { channelId: 'room', producerId: producer.id, producerSessionId: human.user.sessionId,
      kind: 'audio', appData: { mediaType: 'mic' } };
    producers.set(producer.id, { producer, metadata });
    return { peer, producer, metadata, transport, rtpParameters };
  }
  t.after(async () => {
    await voice?.disconnect('test_finished');
    await Promise.allSettled(jobs);
    await Promise.all(sources.map(peer => peer.close()));
    worker.close();
  });
  const one = await makeSource(humans[0]);
  const two = await makeSource(humans[1]);
  let recvTransport;
  voice = new BotVoiceConnection('room', { currentUser: self.user, server: { voiceMode: 'sfu' }, iceServers: [] }, {
    send(message) {
      const job = Promise.resolve().then(async () => {
        const p = message.payload;
        let type, payload;
        switch (message.type) {
          case MessageType.VOICE_JOIN:
            self.voiceState.receivesVoice = p.receiveAudio;
            type = MessageType.VOICE_USER_JOINED;
            payload = { ...self, channelId: 'room', sessionId: self.user.sessionId, participants: [self, ...humans] };
            break;
          case MessageType.VOICE_LEAVE:
            type = MessageType.VOICE_USER_LEFT; payload = { channelId: 'room', sessionId: self.user.sessionId }; break;
          case MessageType.VOICE_STATE_UPDATE:
            self.voiceState = { ...self.voiceState, ...p };
            if (p.isDeafened) recvTransport?.close();
            type = MessageType.VOICE_STATE_CHANGED; payload = { voiceState: self.voiceState }; break;
          case MessageType.SFU_CREATE_WEBRTC_TRANSPORT: {
            const transport = await createTransport();
            if (p.direction === 'recv') recvTransport = transport;
            type = MessageType.SFU_WEBRTC_TRANSPORT_CREATED;
            payload = { channelId: 'room', direction: p.direction, transportOptions: options(transport) }; break;
          }
          case MessageType.SFU_CONNECT_WEBRTC_TRANSPORT:
            await transports.get(p.transportId).connect({ dtlsParameters: p.dtlsParameters });
            type = MessageType.SFU_WEBRTC_TRANSPORT_CONNECTED; payload = { channelId: 'room', transportId: p.transportId }; break;
          case MessageType.SFU_PRODUCE: {
            const producer = await transports.get(p.transportId).produce(p);
            type = MessageType.SFU_PRODUCED; payload = { id: producer.id, channelId: 'room' }; break;
          }
          case MessageType.SFU_GET_PRODUCERS:
            type = MessageType.SFU_PRODUCERS_LIST;
            payload = { channelId: 'room', producers: [...producers.values()].map(entry => entry.metadata), participants: [self, ...humans] }; break;
          case MessageType.SFU_CONSUME: {
            const consumer = await transports.get(p.transportId).consume({ producerId: p.producerId, rtpCapabilities: p.rtpCapabilities });
            type = MessageType.SFU_CONSUMED;
            payload = { ...producers.get(p.producerId).metadata, id: consumer.id, rtpParameters: consumer.rtpParameters }; break;
          }
          default: throw new Error(`Unexpected voice request ${message.type}`);
        }
        voice.handle({ type, payload: structuredClone(payload), requestId: message.requestId });
      }).catch(error => { errors.push(error); voice.handle({ type: MessageType.SERVER_ERROR,
        payload: { message: error.message }, requestId: message.requestId }); }).finally(() => jobs.delete(job));
      jobs.add(job);
    },
    participants() {}, disconnected() {}, error(error) { errors.push(error); },
  });
  await voice.join({ receiveAudio: true });
  const receiver = voice.receiveAudio();
  await Promise.all([one.peer.write(SILENCE), two.peer.write(SILENCE)]);
  await until(() => receiver.queue.length >= 2, 'Initial SFU microphones');
  const first = [(await receiver.next()).value, (await receiver.next()).value];
  assert.deepEqual(new Set(first.map(packet => packet.userId)), new Set(['one', 'two']));
  await voice.writeOpus(SILENCE);
  const sender = voice.sfu;
  one.producer.close();
  producers.delete(one.producer.id);
  voice.handle({ type: MessageType.SFU_PRODUCER_CLOSED, payload: { channelId: 'room', producerId: one.producer.id } });
  await voice.receiveTasks;
  const replacement = await makeSource(humans[0]);
  voice.handle({ type: MessageType.SFU_NEW_PRODUCER, payload: replacement.metadata });
  await voice.receiveTasks;
  assert.equal(voice.isClosed, false, errors.map(error => error.message).join('; '));
  await replacement.peer.write(SILENCE);
  await until(() => receiver.queue.length > 0, 'Replacement SFU microphone');
  assert.equal((await receiver.next()).value.userId, 'one', 'A replaced source has exactly one live receiver');
  const beforeChurn = voice.sfuReceive.peer;
  let current = replacement;
  for (let index = 0; index < 34; index++) {
    current.producer.close();
    producers.delete(current.producer.id);
    voice.handle({ type: MessageType.SFU_PRODUCER_CLOSED, payload: { channelId: 'room', producerId: current.producer.id } });
    await voice.receiveTasks;
    current = await makeSource(humans[0], current);
    voice.handle({ type: MessageType.SFU_NEW_PRODUCER, payload: current.metadata });
    await voice.receiveTasks;
    assert.equal(voice.isClosed, false, errors.map(error => error.message).join('; '));
    await Promise.all([current.peer.write(SILENCE), two.peer.write(SILENCE)]);
    await until(() => receiver.queue.length >= 2, `SFU source lifetime ${index}`);
    const packets = [(await receiver.next()).value, (await receiver.next()).value];
    assert.deepEqual(new Set(packets.map(packet => packet.userId)), new Set(['one', 'two']));
    assert.ok(voice.sfuReceive.peer.pc.getReceivers().length <= 34, 'Retired microphone receivers stay bounded');
  }
  assert.notEqual(voice.sfuReceive.peer, beforeChurn, 'Source churn recycles the receive transport');
  assert.equal(beforeChurn.pc.connectionState, 'closed');
  assert.equal(voice.sfu, sender, 'Source churn must not interrupt publishing');
  const oldReceiver = voice.sfuReceive.peer;
  await voice.setDeafened(true);
  await until(() => oldReceiver.pc.connectionState === 'closed');
  assert.equal(receiver.queue.length, 0);
  await voice.setDeafened(false);
  assert.equal(voice.sfu, sender, 'Listening changes must preserve the publication transport');
  assert.notEqual(voice.sfuReceive.peer, oldReceiver);
  await two.peer.write(SILENCE);
  await until(() => receiver.queue.length > 0, `Undeafened SFU microphone: ${errors.map(error => error.message).join('; ')}`);
  assert.equal((await receiver.next()).value.userId, 'two');
  await receiver.return();
  assert.equal(voice.isReceivingAudio, false);
  await voice.close();
  assert.deepEqual(errors, []);
});
