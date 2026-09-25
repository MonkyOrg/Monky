'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const shared = require('@monky/shared');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..', 'src', 'renderer', 'core', 'webrtc');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const video = { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 };
const codecs = [{ mimeType: 'video/H264', clockRate: 90000,
  sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f' }];
const answer = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 98', 'a=rtpmap:98 H264/90000',
  'a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', ''].join('\r\n');

function fixture(t, { mode = 'p2p', leader = true, audio = true, supported = true, capabilityGate, transportGate,
  sourceVideo = video, sourceCodec, availableCodecs = codecs, negotiatedAv1Level = 5, quality = 'source' } = {}) {
  const sent = [], rpc = [], peers = [], transports = [], tracks = [], admitted = [], states = [], errors = [], probes = [], modes = [];
  const availableProducers = new Map();
  let closeFailures = 0;
  class Track {
    constructor(kind, id) { Object.assign(this, { kind, id, readyState: 'live', enabled: true }); tracks.push(this); }
    stop() { this.readyState = 'ended'; }
  }
  class Peer {
    signalingState = 'stable';
    connectionState = 'new';
    receivers = [];
    remoteGate = null;
    constructor(config) { this.config = config; peers.push(this); }
    async setRemoteDescription(value) { if (this.remoteGate) await this.remoteGate.promise; this.remoteDescription = value; }
    async createAnswer() { return { type: 'answer',
      sdp: sourceCodec === 'av1' ? answer.replace('H264/90000', 'AV1/90000')
        .replace('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f',
          `profile=0;level-idx=${negotiatedAv1Level};tier=0`) : answer }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async addIceCandidate(value) { (this.ice ??= []).push(value); }
    getReceivers() { return this.receivers; }
    getStats() { return Promise.resolve(new Map()); }
    close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
    track(kind, id, mid, streamIds) {
      const track = new Track(kind, id), receiver = { track };
      this.receivers.push(receiver);
      const event = { track, receiver, transceiver: { mid }, streams: streamIds.map(id => ({ id })) };
      this.ontrack?.(event);
      return event;
    }
  }
  class Consumer {
    closed = false;
    constructor(options) {
      Object.assign(this, options);
      this.track = new Track(options.kind, options.id);
      this.rtpReceiver = { track: this.track };
    }
    on() {}
    pause() { this.track.enabled = false; }
    resume() { this.track.enabled = true; }
    close() { this.closed = true; this.track.stop(); }
    getStats() { return Promise.resolve(new Map()); }
  }
  class Transport {
    closed = false;
    callbacks = new Map();
    consumers = [];
    constructor(options) { this.id = options.id; transports.push(this); }
    on(event, callback) { this.callbacks.set(event, callback); }
    async consume(options) {
      if (this.closed) throw new Error('Modeled receive transport is closed.');
      await new Promise((resolve, reject) => this.callbacks.get('connect')({ dtlsParameters: {} }, resolve, reject));
      if (this.closed) throw new Error('Modeled receive transport was closed while connecting.');
      const consumer = new Consumer(options);
      this.consumers.push(consumer);
      return consumer;
    }
    close() { this.closed = true; this.consumers.forEach(consumer => consumer.close()); }
  }
  class Device {
    rtpCapabilities = { codecs: [{ mimeType: 'video/H264', kind: 'video', clockRate: 90000,
      parameters: { 'profile-level-id': '4d001f', 'packetization-mode': 1 } },
    { mimeType: 'video/AV1', kind: 'video', clockRate: 90000, parameters: { profile: 0, 'level-idx': negotiatedAv1Level } }] };
    async load() {}
    createRecvTransport(options) { return new Transport(options); }
  }
  const context = vm.createContext({
    console, crypto, DOMException, TextEncoder, setTimeout, clearTimeout, structuredClone,
    RTCPeerConnection: Peer, RTCRtpReceiver: { getCapabilities: () => ({ codecs: availableCodecs }) },
    navigator: { mediaCapabilities: { decodingInfo: async config => {
      probes.push(config);
      if (capabilityGate) await capabilityGate.promise;
      return { supported };
    } } },
  });
  const modules = new Map();
  const load = name => {
    if (name === '@monky/shared') return shared;
    if (name === 'mediasoup-client') return { Device };
    if (modules.has(name)) return modules.get(name);
    assert.match(name, /^\.\/(?:BrowserScreenP2p|BrowserScreenSfu|BrowserScreenSubscription|browserScreenCodecs)$/);
    const filename = path.join(root, name.slice(2) + '.ts');
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    modules.set(name, exports);
    vm.runInContext(`(function(exports, require) {${code}\n})`, context, { filename })(exports, load);
    return exports;
  };
  const source = { shareId: 'one', instanceId: randomUUID(),
    video: shared.getScreenShareProfile(sourceVideo, 'source', sourceCodec), audio,
    ...(sourceCodec ? { codec: sourceCodec } : {}) };
  const call = { callId: randomUUID(), sessionId: leader ? 'a-viewer' : 'z-viewer', channelId: 'room', mode,
    iceServers: [{ urls: ['stun:example.invalid'] }] };
  const publisherSessionId = 'm-publisher';
  const sub = new (load('./BrowserScreenSubscription').BrowserScreenSubscription)({
    call, publisherSessionId, source, quality, muted: false,
    send: async signal => { sent.push(shared.nativeScreenSignalSchema.parse(signal)); },
    rpc: async (method, payload) => {
      rpc.push({ method, payload });
      const channelId = call.channelId;
      switch (method) {
        case shared.MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES: return { channelId, rtpCapabilities: {} };
        case shared.MessageType.SFU_CREATE_WEBRTC_TRANSPORT:
          if (transportGate) await transportGate.promise;
          return { ...payload, transportOptions: { id: 'owned-recv' } };
        case shared.MessageType.SFU_GET_PRODUCERS: return { channelId, producers: [...availableProducers.values()], participants: [] };
        case shared.MessageType.SFU_CONNECT_WEBRTC_TRANSPORT: return { channelId, transportId: payload.transportId };
        case shared.MessageType.SFU_CONSUME: {
          const producer = availableProducers.get(payload.producerId);
          assert.ok(producer);
          return { ...producer, id: `consumer-${producer.producerId}`,
            rtpParameters: { codecs: [{ mimeType: producer.kind === 'audio' ? 'audio/opus'
              : sourceCodec === 'av1' ? 'video/AV1' : 'video/H264',
            ...(sourceCodec === 'av1' ? { parameters: { profile: 0, 'level-idx': negotiatedAv1Level } } : {}) }] } };
        }
        case shared.MessageType.SFU_CLOSE_WEBRTC_TRANSPORT:
          if (closeFailures-- > 0) throw new Error('The server did not acknowledge transport retirement.');
          return payload;
        default: return payload;
      }
    },
    onTrack: track => admitted.push(track),
    onCaptureMode: mode => modes.push(mode),
    onUnavailable: reason => states.push(reason),
    onError: error => errors.push(error),
  });
  t.after(() => sub.close(false));
  const signal = data => ({
    fromSessionId: publisherSessionId, targetSessionId: call.sessionId, publisherSessionId,
    channelId: call.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: sub.subscriptionId, ...data,
  });
  const control = data => signal({ action: 'control', control: {
    protocol: 'monky-native-screen-p2p', version: audio ? 2 : 1, callId: source.instanceId,
    channelId: call.channelId, connectionId: sub.subscriptionId, generation: 1, ...data,
  } });
  const accepted = signal({ action: 'accepted', backend: 'browser', quality, generation: 1 });
  const publication = (kind, extra = {}) => control({
    type: 'publication', shareId: source.shareId, publicationId: kind === 'audio' ? 2 : 1,
    publicationVersion: 1, metadataVersion: 1, trackId: `${kind}-track`, mid: kind === 'audio' ? '1' : '0',
    streamIds: [source.instanceId], ...(audio ? { kind, syncGroup: source.instanceId } : {}), ...extra,
  });
  const producer = (kind, pipelineId = 'cb54a93e-7e32-41f2-a755-90e3d9459c94') => {
    const value = { channelId: call.channelId, producerId: `${kind}-${pipelineId}`, producerSessionId: publisherSessionId,
      kind, appData: { mediaType: kind === 'audio' ? 'screen_audio' : 'screen_video', shareId: source.shareId,
        nativeScreen: { sourceInstanceId: source.instanceId, pipelineId,
          video: shared.getScreenShareProfile(source.video, quality, source.codec) } } };
    availableProducers.set(value.producerId, value);
    return value;
  };
  async function turn(number = 1) {
    if (leader) await sub.receive(control({ type: 'negotiate', requestVersion: number }));
    else await sub.receive(control({ type: 'turn', turn: number, offererSessionId: publisherSessionId }));
    await sub.receive(control({ type: 'offer', turn: number, sdp: 'modeled offer' }));
    await sub.receive(control({ type: leader ? 'turn-applied' : 'turn-done', turn: number }));
  }
  return { sub, source, call, sent, rpc, peers, transports, tracks, admitted, states, errors, probes, modes,
    signal, control, accepted, publication, producer, turn, load,
    closeFailures: count => { closeFailures = count; },
    open: async () => { await sub.start(); await sub.receive(accepted); } };
}

for (const mode of ['p2p', 'sfu']) {
  test(`${mode}: browser AV1 reduced rendition probes and consumes the exact aligned width`, async t => {
    const f = fixture(t, { mode, sourceCodec: 'av1', quality: '480p30',
      availableCodecs: [{ mimeType: 'video/AV1', clockRate: 90000, sdpFmtpLine: 'profile=0' }] });
    const producer = f.producer('video');
    assert.equal(producer.appData.nativeScreen.video.width, 848);
    await f.open();
    if (mode === 'p2p') await f.turn();
    else assert.equal(f.transports[0].consumers.length, 1);
    assert.equal(f.probes[0].video.width, 848);
    assert.equal(f.probes[0].video.height, 480);
    assert.deepEqual(f.states, []);
  });
  test(`${mode}: browser spectators receive the confirmed mode without renegotiating their media`, async t => {
    const f = fixture(t, { mode });
    await f.sub.start();
    const status = f.signal({ action: 'capture-mode', generation: 1, capture: { mode: 'normal', ready: true } });
    await assert.rejects(f.sub.receive(status), /another browser/);
    await f.sub.receive(f.accepted);
    const before = f.peers.length + f.transports.length;
    await assert.rejects(f.sub.receive({ ...status, generation: 2 }), /another browser/);
    await f.sub.receive({ ...status, subscriptionId: randomUUID() });
    await f.sub.receive({ ...status, capture: { mode: 'game', ready: false } });
    assert.deepEqual(f.modes, []);
    await f.sub.receive(status);
    assert.deepEqual(f.modes, ['normal']);
    assert.equal(f.peers.length + f.transports.length, before);
    f.sub.playing();
    await f.sub.close(true);
    await f.sub.receive({ ...status, capture: { mode: 'game', ready: true } });
    assert.deepEqual(f.modes, ['normal']);
  });
}

test('browser Watch qualifies actual WebRTC Main5.1 decoding before asking for any media', async t => {
  const f = fixture(t);
  assert.equal(f.peers.length, 0);
  await f.sub.start();
  assert.equal(f.probes.length, 1);
  assert.equal(f.probes[0].type, 'webrtc');
  assert.equal(f.probes[0].video.framerate, 120);
  assert.match(f.probes[0].video.contentType, /profile-level-id=4d0033/);
  assert.equal(f.sent[0].backend, 'browser');
  assert.equal(f.peers.length, 0, 'Watch does not create a browser PC before acceptance.');
  await f.sub.receive(f.accepted);
  assert.equal(f.peers.length, 1);
  await f.sub.receive(f.accepted);
  assert.equal(f.peers.length, 1);
});

test('unsupported browser decoder starts no capture request, PC or SFU transport', async t => {
  const f = fixture(t, { supported: false });
  await assert.rejects(f.sub.start(), /H.264 Main at its required level/);
  assert.deepEqual(f.states, ['unsupported']);
  assert.equal(f.sent.length + f.rpc.length + f.peers.length + f.transports.length, 0);
});

for (const [fps, level] of [[30, '0033'], [60, '0034'], [120, '003c']]) {
  test(`4K${fps} browser probe and receive extension agree on level ${level}`, async t => {
    const f = fixture(t, { sourceVideo: { width: 3840, height: 2160, fps, maxBitrateKbps: 80000 } });
    await f.open();
    assert.match(f.probes[0].video.contentType, new RegExp(`profile-level-id=4d${level}`));
    assert.equal(f.probes[0].video.width, 3840);
    assert.equal(f.probes[0].video.height, 2160);
    assert.equal(f.probes[0].video.bitrate, 80000000);
    await f.turn();
    const answer = f.sent.find(message => message.action === 'control' && message.control.type === 'answer');
    assert.ok(answer.control.sdp.includes(`profile-level-id=4d001f;max-recv-level=${level}`));
    assert.deepEqual(f.errors, []);
  });
}

test('unsupported 4K120 browser decode does not silently request a lower rendition', async t => {
  const f = fixture(t, { supported: false,
    sourceVideo: { width: 3840, height: 2160, fps: 120, maxBitrateKbps: 80000 } });
  await assert.rejects(f.sub.start(), /required level/);
  assert.equal(f.sent.length + f.rpc.length + f.peers.length + f.transports.length, 0);
  assert.deepEqual(f.states, ['unsupported']);
});

test('Stop cancels pending codec discovery without waiting for the capability service or sending a late Watch', async t => {
  const gate = deferred(), f = fixture(t, { capabilityGate: gate });
  const starting = assert.rejects(f.sub.start(), { name: 'AbortError' });
  await f.sub.close(true);
  await starting;
  gate.resolve();
  await tick();
  assert.equal(f.sent.length + f.rpc.length + f.peers.length, 0);
});

test('accepted browser media cannot change backend, quality, source or generation', async t => {
  const f = fixture(t);
  await f.sub.start();
  await assert.rejects(f.sub.receive({ ...f.accepted, backend: 'native' }), /requested/);
  await assert.rejects(f.sub.receive({ ...f.accepted, quality: '480p30' }), /requested/);
  await assert.rejects(f.sub.receive({ ...f.accepted, sourceInstanceId: randomUUID() }), /escaped/);
  assert.equal(f.peers.length, 0);
  await f.sub.receive(f.accepted);
  await assert.rejects(f.sub.receive({ ...f.accepted, generation: 2 }), /requested/);
});

for (const leader of [true, false]) test(`receive-only browser negotiates ordered publisher offers when leader=${leader}`, async t => {
  const f = fixture(t, { leader });
  await f.open();
  await f.turn();
  const answer = f.sent.find(message => message.action === 'control' && message.control.type === 'answer');
  assert.ok(answer);
  assert.match(answer.control.sdp, /profile-level-id=4d001f;max-recv-level=0033/);
  assert.match(answer.control.sdp, /useinbandfec=1;stereo=1/);
  assert.equal(f.sent.some(message => message.action === 'control' && message.control.type === 'offer'), false);
  await f.turn(2);
  assert.deepEqual(f.errors, []);
});

test('tracks are quarantined until publisher, source, MID, track and stream metadata match', async t => {
  const f = fixture(t);
  await f.open();
  const event = f.peers[0].track('video', 'video-track', '0', [f.source.instanceId]);
  assert.equal(event.track.enabled, false);
  await f.sub.receive(f.publication('video', { mid: '9' }));
  assert.equal(f.admitted.length, 0);
  await f.sub.receive(f.publication('video', { mid: '0', metadataVersion: 2 }));
  assert.equal(f.admitted[0], event.track);
  assert.equal(event.track.enabled, true);
});

test('audio subscriptions remain tied to the exact current video Watch across mute and metadata changes', async t => {
  const f = fixture(t);
  await f.open();
  await f.sub.receive(f.publication('video'));
  await f.sub.receive(f.publication('audio'));
  await f.sub.setMuted(true);
  await f.sub.receive(f.publication('video', { metadataVersion: 2 }));
  await f.sub.setMuted(false);
  let video;
  for (const signal of f.sent) {
    const control = signal.action === 'control' ? signal.control : null;
    if (control?.type !== 'watch') continue;
    if (control.kind === 'video') video = control;
    else {
      assert.equal(control.video.revision, video.revision);
      assert.equal(control.video.metadataVersion, video.metadataVersion);
      assert.equal(control.video.subscriptionId, video.subscriptionId);
    }
  }
  assert.ok(f.sent.some(value => value.action === 'control' && value.control.kind === 'audio' && !value.control.watching));
});

test('unpublished browser media retains its high-water version and cannot be revived by late metadata', async t => {
  const f = fixture(t);
  await f.open();
  await f.sub.receive(f.publication('video'));
  await f.sub.receive(f.publication('audio'));
  const audio = f.peers[0].track('audio', 'audio-track', '1', [f.source.instanceId]).track;
  const old = f.peers[0].track('video', 'video-track', '0', [f.source.instanceId]).track;
  const watches = f.sent.filter(value => value.action === 'control' && value.control.type === 'watch').length;
  await f.sub.receive(f.control({ type: 'unpublish', kind: 'video', shareId: f.source.shareId,
    publicationId: 1, publicationVersion: 1 }));
  assert.equal(old.readyState, 'ended');
  assert.equal(audio.enabled, false);
  await f.sub.receive(f.publication('video', { metadataVersion: 99 }));
  assert.equal(f.sent.filter(value => value.action === 'control' && value.control.type === 'watch').length, watches);
  await f.sub.receive(f.publication('video', { publicationId: 3, publicationVersion: 2, trackId: 'replacement', mid: '2' }));
  const replacement = f.peers[0].track('video', 'replacement', '2', [f.source.instanceId]).track;
  assert.ok(f.admitted.includes(replacement));
  await f.sub.receive(f.control({ type: 'unpublish', kind: 'video', shareId: f.source.shareId,
    publicationId: 1, publicationVersion: 1 }));
  assert.equal(replacement.readyState, 'live');
  assert.equal(audio.enabled, true);
});

test('same-version publication replays must preserve their exact track binding and media identity', async t => {
  const f = fixture(t);
  await f.open();
  await f.sub.receive(f.publication('video'));
  await assert.rejects(f.sub.receive(f.publication('video', { trackId: 'different' })), /binding without/);
  await assert.rejects(f.sub.receive(f.publication('video', { publicationId: 4 })), /changed identity/);
  await assert.rejects(f.sub.receive(f.publication('audio', { mid: '0' })), /cannot share/);
});

test('metadata revisions quarantine an admitted binding without delivering the same track twice', async t => {
  const f = fixture(t);
  await f.open();
  await f.sub.receive(f.publication('video'));
  const event = f.peers[0].track('video', 'video-track', '0', [f.source.instanceId]);
  assert.equal(f.admitted.length, 1);
  await f.sub.receive(f.publication('video', { metadataVersion: 2, mid: '9' }));
  assert.equal(event.track.enabled, false);
  await f.sub.receive(f.publication('video', { metadataVersion: 3, mid: '0' }));
  assert.equal(event.track.enabled, true);
  f.peers[0].ontrack(event);
  assert.equal(f.admitted.length, 1);
  assert.equal(event.track.enabled, true);
});

test('Stop closes the real browser boundary immediately and drains an outstanding SDP operation', async t => {
  const f = fixture(t);
  await f.open();
  await f.sub.receive(f.control({ type: 'negotiate', requestVersion: 1 }));
  const peer = f.peers[0], gate = peer.remoteGate = deferred();
  const offering = assert.rejects(f.sub.receive(f.control({ type: 'offer', turn: 1, sdp: 'pending offer' })), { name: 'AbortError' });
  await tick();
  const closing = f.sub.close(true);
  assert.equal(peer.signalingState, 'closed');
  gate.resolve();
  await offering;
  await closing;
  assert.equal(f.sent.filter(value => value.action === 'stop').length, 1);
  assert.equal(f.sent.some(value => value.action === 'control' && value.control.type === 'answer'), false);
});

test('SFU consumes only the requested source/profile and pairs audio with its exact video pipeline', async t => {
  const f = fixture(t, { mode: 'sfu' });
  const unrelatedAudio = f.producer('audio', 'c5a5f9f7-c7f1-461a-bb97-534f062ec94a');
  const audio = f.producer('audio'), video = f.producer('video');
  await f.sub.addProducer(unrelatedAudio);
  await f.sub.addProducer(audio);
  await f.open();
  assert.deepEqual(f.admitted.map(track => track.kind), ['video', 'audio']);
  const consumed = f.rpc.filter(value => value.method === shared.MessageType.SFU_CONSUME);
  assert.deepEqual(consumed.map(value => value.payload.producerId), [video.producerId, audio.producerId]);
  assert.equal(consumed[0].payload.rtpCapabilities.codecs[0].parameters['max-recv-level'], '0033');
  assert.equal(f.transports[0].consumers[1].codecOptions.opusStereo, true);
  await f.sub.setMuted(true);
  assert.equal(f.transports[0].consumers[1].track.enabled, false);
  await f.sub.setMuted(false);
  assert.equal(f.transports[0].consumers[1].track.enabled, true);
});

test('an SFU transport allocated after Stop is acknowledged and closed without opening a local transport', async t => {
  const gate = deferred(), f = fixture(t, { mode: 'sfu', transportGate: gate });
  await f.sub.start();
  const opening = assert.rejects(f.sub.receive(f.accepted), { name: 'AbortError' });
  await tick();
  assert.ok(f.rpc.some(value => value.method === shared.MessageType.SFU_CREATE_WEBRTC_TRANSPORT));
  const closing = f.sub.close(true);
  gate.resolve();
  await opening;
  await closing;
  assert.equal(f.transports.length, 0);
  assert.equal(f.rpc.filter(value => value.method === shared.MessageType.SFU_CLOSE_WEBRTC_TRANSPORT).length, 1);
});

test('browser SFU teardown retains failed remote obligations for Retry while retiring every local track', async t => {
  const f = fixture(t, { mode: 'sfu' });
  f.producer('video'); f.producer('audio');
  await f.open();
  f.closeFailures(1);
  await assert.rejects(f.sub.close(true), /retirement failed/);
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  assert.ok(f.transports.every(transport => transport.closed));
  await f.sub.close(true);
  assert.equal(f.rpc.filter(value => value.method === shared.MessageType.SFU_CLOSE_WEBRTC_TRANSPORT).length, 2);
  assert.equal(f.sent.filter(value => value.action === 'stop').length, 1);
});

for (const mode of ['p2p', 'sfu']) {
  test(`${mode}: AV1 receiving probes AV1 instead of claiming H264 implies support`, async t => {
    const f = fixture(t, { mode, sourceCodec: 'av1',
      sourceVideo: { width: 852, height: 480, fps: 30, maxBitrateKbps: 1500 },
      availableCodecs: [...codecs, { mimeType: 'video/AV1', clockRate: 90000, sdpFmtpLine: 'profile=0' }] });
    if (mode === 'sfu') f.producer('video');
    await f.open();
    assert.equal(f.probes[0].video.contentType, 'video/AV1;profile=0;level-idx=4;tier=0');
    assert.equal(f.sent[0].action, 'watch');
    if (mode === 'p2p') await f.turn();
    if (mode === 'sfu') {
      const consumed = f.rpc.find(value => value.method === shared.MessageType.SFU_CONSUME);
      assert.deepEqual(consumed.payload.rtpCapabilities.codecs.map(codec => codec.mimeType), ['video/AV1']);
      assert.equal(consumed.payload.rtpCapabilities.codecs[0].parameters['max-recv-level'], undefined);
    }
  });
  test(`${mode}: H264-only receiver explicitly rejects AV1 before media allocation`, async t => {
    const f = fixture(t, { mode, sourceCodec: 'av1' });
    await assert.rejects(f.sub.start(), /AV1.*Select H.264/);
    assert.deepEqual(f.states, ['unsupported']);
    assert.equal(f.sent.length + f.peers.length + f.transports.length + f.probes.length, 0);
  });
  test(`${mode}: default AV1 level 3.1 is not advertised as supporting 1080p120`, async t => {
    const f = fixture(t, { mode, sourceCodec: 'av1',
      availableCodecs: [{ mimeType: 'video/AV1', clockRate: 90000, sdpFmtpLine: 'profile=0;level-idx=5;tier=0' }] });
    await assert.rejects(f.sub.start(), /AV1.*Select H.264/);
    assert.deepEqual(f.states, ['unsupported']);
    assert.equal(f.sent.length + f.peers.length + f.transports.length + f.probes.length, 0);
  });
  test(`${mode}: insufficient negotiated AV1 level is rejected even when the capability API claims a higher level`, async t => {
    const f = fixture(t, { mode, sourceCodec: 'av1',
      availableCodecs: [{ mimeType: 'video/AV1', clockRate: 90000, sdpFmtpLine: 'profile=0;level-idx=23;tier=0' }] });
    if (mode === 'sfu') {
      f.producer('video');
      await assert.rejects(f.open(), /AV1 receive level is insufficient/);
    } else {
      await f.open();
      await assert.rejects(f.turn(), /AV1 receive level is insufficient/);
    }
    assert.ok(f.states.includes('unsupported'));
  });
  test(`${mode}: explicitly sufficient AV1 API and negotiated levels admit the requested high rendition`, async t => {
    const f = fixture(t, { mode, sourceCodec: 'av1', negotiatedAv1Level: 23,
      availableCodecs: [{ mimeType: 'video/AV1', clockRate: 90000, sdpFmtpLine: 'profile=0;level-idx=23;tier=0' }] });
    if (mode === 'sfu') f.producer('video');
    await f.open();
    if (mode === 'p2p') await f.turn();
    assert.equal(f.probes[0].video.contentType, 'video/AV1;profile=0;level-idx=12;tier=0');
    assert.deepEqual(f.states, []);
  });
}

test('P2P screen answers cannot silently negotiate a different codec than the source descriptor', t => {
  const f = fixture(t);
  const { assertBrowserScreenCodec } = f.load('./browserScreenCodecs');
  assert.doesNotThrow(() => assertBrowserScreenCodec(answer, 'h264'));
  assert.throws(() => assertBrowserScreenCodec(answer, 'av1'), /does not match/);
  const av1 = answer.replace('H264/90000', 'AV1/90000');
  assert.doesNotThrow(() => assertBrowserScreenCodec(av1, 'av1'));
  assert.throws(() => assertBrowserScreenCodec(av1, 'h264'), /does not match/);
  assert.throws(() => assertBrowserScreenCodec(av1, 'av1', video), /level is insufficient/);
  assert.doesNotThrow(() => assertBrowserScreenCodec(av1, 'av1',
    { width: 852, height: 480, fps: 30, maxBitrateKbps: 1500 }));
  const { supportsBrowserAv1Level } = f.load('./browserScreenCodecs');
  assert.equal(supportsBrowserAv1Level(video, { 'level-idx': 23 }), true);
  for (const level of [5, '5', -1, 24, 31, 'invalid', null])
    assert.equal(supportsBrowserAv1Level(video, { 'level-idx': level }), false);
  for (const profile of [-1, 3, 'invalid', null])
    assert.equal(supportsBrowserAv1Level(video, { profile, 'level-idx': 23 }), false);
  for (const tier of [-1, 2, 'invalid', null])
    assert.equal(supportsBrowserAv1Level(video, { tier, 'level-idx': 23 }), false);
});
