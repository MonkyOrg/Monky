'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { getScreenShareProfile } = require('@monky/shared');
const { NativeScreenSubscription } = require('../runtime/nativeScreenSubscription.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(mode = 'p2p', { audio = false } = {}) {
  const sent = [], errors = [], phases = [], endpoints = [], states = [];
  const source = { shareId: 'owned-screen', instanceId: randomUUID(), audio,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  const subscription = new NativeScreenSubscription({
    sessionId: 'viewer', publisherSessionId: 'publisher', channelId: 'room', mode,
    source, quality: '720p60', iceServers: [],
    send: async value => { sent.push(value); }, onError: error => errors.push(error),
    onState: state => { phases.push(state.type); states.push(state); },
    retirePresentation: async () => { phases.push('presentation-retired'); },
    createEndpoint(options) {
      const endpoint = {
        options, ready: Promise.resolve(), closed: false, producers: [], peers: [], controls: [],
        async connectPeer(id, configuration) { this.peers.push({ id, configuration }); },
        async receiveControl(id, control) { this.controls.push({ id, control }); },
        async addRemoteProducer(value) { this.producers.push(value); },
        async removeRemoteProducer(id) { this.producers = this.producers.filter(value => value.producerId !== id); },
        async close() { assert.ok(phases.includes('presentation-retired')); this.closed = true; phases.push('engine-retired'); },
        snapshot() { return { closed: this.closed }; },
      };
      endpoints.push(endpoint);
      return endpoint;
    },
  });
  const accepted = () => ({
    fromSessionId: 'publisher', targetSessionId: 'viewer', publisherSessionId: 'publisher', channelId: 'room',
    shareId: source.shareId, sourceInstanceId: source.instanceId, subscriptionId: subscription.subscriptionId,
    action: 'accepted', quality: '720p60', backend: 'native', generation: 9,
  });
  const producer = quality => ({
    channelId: 'room', producerId: randomUUID(), producerSessionId: 'publisher', kind: 'video',
    appData: { mediaType: 'screen_video', shareId: source.shareId,
      nativeScreen: { sourceInstanceId: source.instanceId, pipelineId: randomUUID(), video: getScreenShareProfile(source.video, quality) } },
  });
  return { subscription, endpoints, sent, errors, phases, states, accepted, producer };
}

for (const mode of ['p2p', 'sfu']) {
  test(`${mode}: capture mode only confirms real frames of the current accepted subscription`, async () => {
    const f = fixture(mode);
    const { quality: _quality, backend: _backend, ...scope } = f.accepted();
    const status = { ...scope, action: 'capture-mode', capture: { mode: 'normal', ready: true } };
    await f.subscription.start();
    await assert.rejects(f.subscription.receive(status));
    await f.subscription.receive(f.accepted());
    await assert.rejects(f.subscription.receive({ ...status, generation: 10 }));
    await f.subscription.receive({ ...status, subscriptionId: randomUUID() });
    await f.subscription.receive({ ...status, capture: { mode: 'game', ready: false } });
    assert.equal(f.states.some(state => state.type === 'capture-mode'), false);
    await f.subscription.receive(status);
    assert.equal(f.states.at(-1).mode, 'normal');
    f.endpoints[0].options.onState({ type: 'frame' });
    await f.subscription.close();
    const count = f.states.length;
    await f.subscription.receive({ ...status, capture: { mode: 'game', ready: true } });
    assert.equal(f.states.length, count);
  });
}

test('one Game startup may cover a bounded Normal retry but repeated status cannot renew the frame deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await f.subscription.start();
  await f.subscription.receive(f.accepted());
  const { quality: _quality, backend: _backend, ...scope } = f.accepted();
  const status = { ...scope, action: 'capture-mode', capture: { mode: 'game', ready: false } };
  await f.subscription.receive(status);
  t.mock.timers.tick(30000);
  assert.deepEqual(f.errors, []);
  await f.subscription.receive(status);
  t.mock.timers.tick(45000);
  assert.equal(f.errors.length, 1);
  await f.subscription.close();
});

test('receiver creates no engine before Watch has been accepted', async () => {
  const f = fixture();
  await f.subscription.start();
  assert.equal(f.endpoints.length, 0);
  assert.equal(f.sent[0].action, 'watch');
  await f.subscription.receive(f.accepted());
  assert.equal(f.endpoints.length, 1);
  assert.equal(f.endpoints[0].peers[0].configuration.connectionId, f.subscription.subscriptionId);
  assert.equal(f.endpoints[0].peers[0].configuration.generation, 9);
  await f.subscription.receive(f.accepted());
  assert.equal(f.endpoints.length, 1);
  await f.subscription.close();
  assert.equal(f.sent.at(-1).action, 'stop');
  assert.equal(f.subscription.snapshot().closed, true);
  assert.deepEqual(f.errors, []);
});

test('Stop before Accepted cannot create a late receiver or retain a presentation', async () => {
  const f = fixture();
  await f.subscription.start();
  await f.subscription.close();
  await f.subscription.receive(f.accepted());
  assert.equal(f.endpoints.length, 0);
  assert.equal(f.phases.includes('presentation-retired'), true);
});

test('failed presentation retirement retains the subscription and Retry performs the missing acknowledgement', async () => {
  const f = fixture();
  await f.subscription.start();
  await f.subscription.receive(f.accepted());
  let attempts = 0;
  const retire = f.subscription.retirePresentation;
  f.subscription.retirePresentation = async id => {
    if (++attempts === 1) throw new Error('Renderer has not released its presentation');
    await retire(id);
  };
  f.endpoints[0].close = async function() { this.closed = true; };
  await assert.rejects(f.subscription.close(), /shutdown failures/);
  assert.equal(f.endpoints[0].closed, true);
  assert.equal(f.subscription.snapshot().closed, false, 'Native closure cannot forge renderer retirement.');
  await f.subscription.close();
  assert.equal(attempts, 2);
  assert.equal(f.subscription.snapshot().closed, true);
});

test('continuous frames emit a single playing transition instead of frame-rate IPC updates', async () => {
  const f = fixture();
  await f.subscription.start();
  await f.subscription.receive(f.accepted());
  for (let frame = 0; frame < 360; frame++) f.endpoints[0].options.onState({ type: 'frame' });
  assert.deepEqual(f.phases, ['connecting', 'playing']);
  await f.subscription.close();
});

test('accepted media cannot substitute backend, quality, source or generation', async () => {
  const f = fixture();
  await f.subscription.start();
  await assert.rejects(f.subscription.receive({ ...f.accepted(), quality: '480p30' }));
  await assert.rejects(f.subscription.receive({ ...f.accepted(), backend: 'browser' }));
  await assert.rejects(f.subscription.receive({ ...f.accepted(), sourceInstanceId: randomUUID() }));
  await f.subscription.receive(f.accepted());
  await assert.rejects(f.subscription.receive({ ...f.accepted(), generation: 10 }));
  await f.subscription.close();
});

test('stale subscriptions are ignored instead of opening a replacement receiver', async () => {
  const f = fixture();
  await f.subscription.start();
  await f.subscription.receive({ ...f.accepted(), subscriptionId: randomUUID() });
  assert.equal(f.endpoints.length, 0);
  await f.subscription.close();
});

test('SFU producers can precede Accepted but only the requested rendition is consumed once', async () => {
  const f = fixture('sfu');
  const correct = f.producer('720p60');
  await f.subscription.start();
  await f.subscription.addRemoteProducer(f.producer('source'));
  await f.subscription.addRemoteProducer(correct);
  assert.equal(f.endpoints.length, 0);
  await f.subscription.receive(f.accepted());
  await f.subscription.addRemoteProducer(correct);
  assert.deepEqual(f.endpoints[0].producers, [correct]);
  await f.subscription.removeRemoteProducer(correct.producerId);
  assert.equal(f.endpoints[0].producers.length, 0);
  await f.subscription.close();
});

test('producer arriving on completion of an empty SFU batch is not stranded', async () => {
  const f = fixture('sfu');
  await f.subscription.start();
  await f.subscription.receive(f.accepted());
  const empty = f.subscription.consumePending();
  const producer = f.producer('720p60');
  await Promise.all([empty, f.subscription.addRemoteProducer(producer)]);
  assert.deepEqual(f.endpoints[0].producers, [producer]);
  await f.subscription.close();
});

test('early SFU audio waits for its exact video rendition rather than failing or binding another pipeline', async () => {
  const f = fixture('sfu', { audio: true });
  const video = f.producer('720p60');
  const audio = { ...video, producerId: randomUUID(), kind: 'audio',
    appData: { ...video.appData, mediaType: 'screen_audio' } };
  await f.subscription.start();
  await f.subscription.addRemoteProducer(audio);
  await f.subscription.receive(f.accepted());
  assert.equal(f.endpoints[0].producers.length, 0);
  const unrelated = f.producer('720p60');
  await f.subscription.addRemoteProducer(unrelated);
  assert.deepEqual(f.endpoints[0].producers, [unrelated]);
  await f.subscription.addRemoteProducer(video);
  assert.deepEqual(f.endpoints[0].producers, [unrelated, video, audio]);
  await f.subscription.close();
  assert.deepEqual(f.errors, []);
});

test('a video-only source cannot acquire an undeclared audio producer', async () => {
  const f = fixture('sfu');
  await f.subscription.start();
  const video = f.producer('720p60');
  await f.subscription.addRemoteProducer({ ...video, kind: 'audio', producerSessionId: 'another-publisher',
    appData: { ...video.appData, mediaType: 'screen_audio' } });
  await assert.rejects(f.subscription.addRemoteProducer({ ...video, kind: 'audio',
    appData: { ...video.appData, mediaType: 'screen_audio' } }));
  await f.subscription.close();
});

test('publisher closure retires presentation before its engine and does not send a redundant Stop', async () => {
  const f = fixture();
  await f.subscription.start();
  await f.subscription.receive(f.accepted());
  const { quality: _quality, generation: _generation, backend: _backend, ...scope } = f.accepted();
  await f.subscription.receive({ ...scope, action: 'closed', reason: 'capture-failed' });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.phases.slice(-4), ['unavailable', 'presentation-retired', 'engine-retired', 'closed']);
  await tick();
  assert.deepEqual(f.errors, []);
});
