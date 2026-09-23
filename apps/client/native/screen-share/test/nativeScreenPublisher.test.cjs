'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { NativeScreenPublisher, MAXIMUM_PROFILE_VIEWERS } = require('../runtime/nativeScreenPublisher.cjs');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ readiness, mode = 'p2p', closeGate } = {}) {
  const endpoints = [], sent = [], errors = [], previews = [];
  const source = { shareId: 'owned-screen', instanceId: randomUUID(), audio: false,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  const publisher = new NativeScreenPublisher({
    sessionId: 'publisher', channelId: 'room', mode, source, iceServers: [],
    send: async value => { sent.push(value); }, onError: error => errors.push(error), onState() {},
    onPreview: value => previews.push(value),
    createEndpoint(options) {
      const endpoint = {
        options, ready: readiness?.promise ?? Promise.resolve(), demand: 0, closed: false, peers: new Set(), controls: [],
        async setDemand(count, preview = false) {
          this.demand = count;
          this.preview = preview;
          if (count === 0 && !preview) { if (closeGate) await closeGate.promise; this.closed = true; this.peers.clear(); }
        },
        async connectPeer(id, configuration) {
          assert.equal(this.closed, false);
          assert.equal(this.peers.has(id), false);
          assert.ok(sent.some(value => value.targetSessionId === id && value.action === 'accepted'
            && value.subscriptionId === configuration.connectionId && value.generation === configuration.generation));
          this.peers.add(id);
        },
        async closePeer(id) { this.peers.delete(id); },
        async receiveControl(id, control) { this.controls.push({ id, control }); },
        snapshot() { return { closed: this.closed, demand: this.demand }; },
      };
      endpoints.push(endpoint);
      return endpoint;
    },
  });
  const watch = (id, quality = 'source') => ({
    action: 'watch', fromSessionId: id, targetSessionId: 'publisher', publisherSessionId: 'publisher', channelId: 'room',
    shareId: source.shareId, sourceInstanceId: source.instanceId, subscriptionId: randomUUID(), quality, backend: 'native',
  });
  const stop = request => {
    const { quality: _quality, backend: _backend, ...scope } = request;
    return { ...scope, action: 'stop' };
  };
  return { publisher, endpoints, sent, errors, previews, watch, stop, source };
}

test('local preview uses an existing watched rendition and returns to local-only capture after the last viewer', async () => {
  const f = fixture(), first = f.watch('first'), second = f.watch('second', '480p30');
  assert.deepEqual(f.previews, []);
  assert.equal(f.endpoints.length, 0);
  await f.publisher.receive(first);
  await f.publisher.receive(second);
  await f.publisher.setPreviewEnabled(true);
  f.previews.length = 0;
  const frame = { data: Buffer.from([1, 2, 3]), timestampUs: 1000, keyframe: true };
  f.endpoints[0].options.onPreview(frame);
  f.endpoints[1].options.onPreview(frame);
  assert.equal(f.previews.length, 1);
  assert.equal(f.previews[0].frame, frame);
  assert.equal(f.previews[0].video.width, 1920);
  await f.publisher.receive(f.stop(first));
  assert.equal(f.previews.at(-1), null);
  f.endpoints[1].options.onPreview(frame);
  assert.equal(f.previews.at(-1).video.width, 852);
  await f.publisher.receive(f.stop(second));
  assert.equal(f.previews.at(-1), null);
  assert.equal(f.endpoints.length, 3);
  assert.equal(f.endpoints[2].demand, 0);
  assert.equal(f.endpoints[2].preview, true);
  assert.equal(f.endpoints[2].options.quality, 'source');
  await f.publisher.setPreviewEnabled(false);
  assert.equal(f.publisher.snapshot().pipelines.length, 0);
  await f.publisher.close();
});

for (const mode of ['p2p', 'sfu']) {
  test(`${mode}: capture badges follow the actual subscribed rendition and local preview, not the requested method`, async () => {
    const f = fixture({ mode });
    await f.publisher.receive(f.watch('game-viewer'));
    await f.publisher.receive({ ...f.watch('normal-viewer', '480p30'), backend: 'browser' });
    await f.publisher.setPreviewEnabled(true);
    f.endpoints[0].options.onState({ type: 'capture-mode', capture: { mode: 'game', ready: true } });
    f.endpoints[1].options.onState({ type: 'capture-mode', capture: { mode: 'normal', ready: false } });
    f.endpoints[1].options.onState({ type: 'capture-mode', capture: { mode: 'normal', ready: true } });
    await tick();
    const notices = f.sent.filter(value => value.action === 'capture-mode');
    assert.deepEqual(notices.map(value => [value.targetSessionId, value.capture.mode, value.capture.ready]), [
      ['game-viewer', 'game', true], ['normal-viewer', 'normal', false], ['normal-viewer', 'normal', true],
    ]);
    for (const notice of notices) {
      assert.equal(notice.generation, f.sent.find(value => value.action === 'accepted'
        && value.targetSessionId === notice.targetSessionId).generation);
    }
    f.endpoints[0].options.onPreview({ data: Buffer.from([1]), timestampUs: 1000, keyframe: true });
    assert.equal(f.previews.at(-1).captureMode, 'game');
    await f.publisher.receive(f.watch('later-viewer', '480p30'));
    const later = f.sent.findLast(value => value.action === 'capture-mode');
    assert.equal(later.targetSessionId, 'later-viewer');
    assert.deepEqual(later.capture, { mode: 'normal', ready: true });
    assert.equal(f.endpoints.length, 2);
    await f.publisher.close();
    const sent = f.sent.length;
    f.endpoints[0].options.onState({ type: 'capture-mode', capture: { mode: 'normal', ready: true } });
    assert.equal(f.sent.length, sent);
    assert.deepEqual(f.errors, []);
  });
}

test('a capture status produced while Accepted is pending waits for its acknowledgement before being sent', async () => {
  const f = fixture(), gate = deferred();
  const send = f.publisher.send;
  f.publisher.send = async value => { await send(value); if (value.action === 'accepted') await gate.promise; };
  const opening = f.publisher.receive(f.watch('viewer'));
  await tick();
  f.endpoints[0].options.onState({ type: 'capture-mode', capture: { mode: 'normal', ready: true } });
  await tick();
  assert.equal(f.sent.filter(value => value.action === 'capture-mode').length, 0);
  gate.resolve();
  await opening;
  assert.deepEqual(f.sent.map(value => value.action), ['accepted', 'capture-mode']);
  await f.publisher.close();
});

for (const mode of ['p2p', 'sfu']) {
  test(`${mode}: local preview has no viewer, signaling or peer and stops when its own demand ends`, async () => {
    const f = fixture({ mode });
    await f.publisher.setPreviewEnabled(true);
    assert.equal(f.endpoints.length, 1);
    assert.equal(f.endpoints[0].demand, 0);
    assert.equal(f.endpoints[0].preview, true);
    assert.equal(f.endpoints[0].peers.size, 0);
    assert.deepEqual(f.sent, []);
    assert.equal(f.publisher.snapshot().viewers, 0);
    f.endpoints[0].options.onPreview({ data: Buffer.from([1]), timestampUs: 1000, keyframe: true });
    assert.equal(f.previews.at(-1).video.fps, 120);
    await f.publisher.setPreviewEnabled(false);
    assert.equal(f.endpoints[0].closed, true);
    assert.equal(f.publisher.snapshot().pipelines.length, 0);
    assert.deepEqual(f.sent, []);
    await f.publisher.close();
  });
}

test('pausing local preview never stops an existing spectator or creates another encoder', async () => {
  const f = fixture();
  await f.publisher.setPreviewEnabled(true);
  const watched = f.watch('viewer');
  await f.publisher.receive(watched);
  assert.equal(f.endpoints.length, 1);
  await f.publisher.setPreviewEnabled(false);
  assert.equal(f.endpoints[0].closed, false);
  assert.equal(f.endpoints[0].demand, 1);
  assert.equal(f.endpoints[0].preview, false);
  assert.deepEqual([...f.endpoints[0].peers], ['viewer']);
  const before = f.previews.length;
  f.endpoints[0].options.onPreview({ data: Buffer.from([1]), timestampUs: 1000, keyframe: true });
  assert.equal(f.previews.length, before);
  await f.publisher.receive(f.stop(watched));
  assert.equal(f.endpoints[0].closed, true);
  await f.publisher.close();
});

test('a different first viewer profile retires local-only capture before starting the selected rendition', async () => {
  const f = fixture(), closing = deferred();
  await f.publisher.setPreviewEnabled(true);
  const original = f.endpoints[0];
  original.setDemand = async function(count, preview) {
    this.demand = count; this.preview = preview;
    if (count === 0 && !preview) { await closing.promise; this.closed = true; }
  };
  const opening = f.publisher.receive(f.watch('viewer', '480p30'));
  await tick();
  assert.equal(f.endpoints.length, 1, 'The old capture must retire before a different profile is created.');
  closing.resolve();
  await opening;
  assert.equal(original.closed, true);
  assert.equal(f.endpoints.length, 2);
  assert.equal(f.endpoints[1].options.quality, '480p30');
  assert.equal(f.endpoints[1].preview, true);
  await f.publisher.close();
});

test('announcing a source is inert; viewers of one profile share one real endpoint', async () => {
  const { publisher, endpoints, watch, stop } = fixture();
  assert.equal(endpoints.length, 0);
  const a = watch('viewer-a'), b = watch('viewer-b');
  await Promise.all([publisher.receive(a), publisher.receive(b)]);
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].demand, 2);
  assert.deepEqual([...endpoints[0].peers].sort(), ['viewer-a', 'viewer-b']);
  await publisher.receive(stop(a));
  assert.equal(endpoints[0].closed, false);
  assert.equal(endpoints[0].demand, 1);
  assert.deepEqual([...endpoints[0].peers], ['viewer-b']);
  await publisher.receive(stop(b));
  assert.equal(endpoints[0].closed, true);
  assert.equal(publisher.snapshot().pipelines.length, 0);
  const again = watch('viewer-a');
  await publisher.receive(again);
  assert.equal(endpoints.length, 2, 'A closed native engine cannot be reused for the next Watch.');
  await publisher.close();
});

test('different profiles coexist and a quality switch retires only its old demand', async () => {
  const { publisher, endpoints, watch, stop } = fixture();
  const a = watch('a'), b = watch('b');
  await Promise.all([publisher.receive(a), publisher.receive(b)]);
  const changed = watch('a', '720p60');
  await publisher.receive(changed);
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints[0].demand, 1);
  assert.equal(endpoints[1].options.quality, '720p60');
  await publisher.receive(stop(a));
  assert.equal(endpoints[1].demand, 1, 'A late Stop must not revoke the new quality subscription.');
  await publisher.receive(stop(b));
  assert.equal(endpoints[0].closed, true);
  assert.equal(endpoints[1].closed, false);
  await publisher.close();
});

test('duplicate Watch is idempotent and cannot change a subscription in place', async () => {
  const { publisher, endpoints, watch } = fixture();
  const request = watch('a');
  await Promise.all([publisher.receive(request), publisher.receive(request)]);
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].peers.size, 1);
  await assert.rejects(publisher.receive({ ...request, quality: '480p30' }));
  await publisher.close();
});

test('Stop during native startup cancels publication and retires the allocated engine', async () => {
  const readiness = deferred();
  const { publisher, endpoints, sent, watch, stop } = fixture({ readiness });
  const request = watch('a');
  const opening = publisher.receive(request);
  await tick();
  await publisher.receive(stop(request));
  assert.equal(endpoints[0].closed, true);
  readiness.resolve();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(sent.some(value => value.action === 'accepted'), false);
  await publisher.close();
});

test('a replacement profile waits for real old-engine closure', async () => {
  const closeGate = deferred();
  const { publisher, endpoints, watch, stop } = fixture({ closeGate });
  const a = watch('a');
  await publisher.receive(a);
  const stopping = publisher.receive(stop(a));
  const opening = publisher.receive(watch('b'));
  await tick();
  assert.equal(endpoints.length, 1);
  closeGate.resolve();
  await Promise.all([stopping, opening]);
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints[0].closed, true);
  await publisher.close();
});

test('per-profile admission preserves the native engine resource bound', async () => {
  const { publisher, endpoints, sent, watch } = fixture();
  await Promise.all(Array.from({ length: MAXIMUM_PROFILE_VIEWERS + 1 }, (_, index) => publisher.receive(watch(`v${index}`))));
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].peers.size, MAXIMUM_PROFILE_VIEWERS);
  assert.equal(sent.filter(value => value.action === 'closed' && value.reason === 'capacity-exceeded').length, 1);
  await publisher.close();
});

test('peer-local failure leaves the other spectator and profile running', async () => {
  const { publisher, endpoints, watch } = fixture();
  await Promise.all([publisher.receive(watch('a')), publisher.receive(watch('b'))]);
  endpoints[0].options.onError(new Error('Peer disconnected'), { remoteSessionId: 'a' });
  await tick();
  assert.equal(endpoints[0].closed, false);
  assert.equal(endpoints[0].demand, 1);
  assert.deepEqual([...endpoints[0].peers], ['b']);
  await publisher.close();
});

test('late errors from an old subscription cannot revoke its replacement or unrelated peers', async () => {
  const { publisher, endpoints, sent, watch } = fixture();
  const previous = watch('a');
  await Promise.all([publisher.receive(previous), publisher.receive(watch('b'))]);
  const oldGeneration = sent.find(value => value.action === 'accepted' && value.targetSessionId === 'a').generation;
  await publisher.receive(watch('a'));
  endpoints[0].options.onError(new Error('Late peer failure'), {
    remoteSessionId: 'a', connectionId: previous.subscriptionId, generation: oldGeneration,
  });
  await tick();
  assert.equal(endpoints[0].closed, false);
  assert.equal(endpoints[0].demand, 2);
  assert.deepEqual([...endpoints[0].peers].sort(), ['a', 'b']);
  await publisher.close();
});

test('simultaneous Watch and Stop reserve demand before asynchronous setup yields', async () => {
  const readiness = deferred();
  const { publisher, endpoints, watch, stop } = fixture({ readiness });
  const a = watch('a');
  const openingA = publisher.receive(a);
  const openingB = publisher.receive(watch('b'));
  await publisher.receive(stop(a));
  readiness.resolve();
  await assert.rejects(openingA, { name: 'AbortError' });
  await openingB;
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].closed, false);
  assert.equal(endpoints[0].demand, 1);
  await publisher.close();
});

test('source failure closes its viewers, while another rendition remains independent', async () => {
  const { publisher, endpoints, sent, watch } = fixture();
  await publisher.receive(watch('a'));
  await publisher.receive(watch('b', '720p60'));
  endpoints[0].options.onError(Object.assign(new Error('Window vanished'), { code: 'ERR_SCREEN_CAPTURE_SOURCE_LOST' }));
  await tick();
  assert.equal(endpoints[0].closed, true);
  assert.equal(endpoints[1].closed, false);
  assert.ok(sent.some(value => value.targetSessionId === 'a' && value.action === 'closed' && value.reason === 'capture-failed'));
  await publisher.close();
});

test('SFU last-viewer removal closes the publishing endpoint, not just a consumer', async () => {
  const { publisher, endpoints, watch, stop } = fixture({ mode: 'sfu' });
  const request = watch('a');
  await publisher.receive(request);
  assert.equal(endpoints[0].demand, 1);
  assert.equal(endpoints[0].peers.size, 0);
  await publisher.receive(stop(request));
  assert.equal(endpoints[0].closed, true);
  await publisher.close();
});

for (const mode of ['p2p', 'sfu']) {
  test(`${mode}: publisher Stop retires shared pipelines without restarting remaining-viewer demand`, async () => {
    const f = fixture({ mode });
    await f.publisher.receive(f.watch('first'));
    await f.publisher.receive(f.watch('second'));
    await f.publisher.setPreviewEnabled(true);
    const endpoint = f.endpoints[0], demandUpdates = [];
    const original = endpoint.setDemand;
    endpoint.setDemand = async function (count, preview) {
      demandUpdates.push([count, preview]);
      if (count > 0) {
        await tick();
        if (this.closed) throw new DOMException('The native screen endpoint was retired.', 'AbortError');
      }
      return original.call(this, count, preview);
    };
    await f.publisher.close();
    assert.deepEqual(demandUpdates, [[0, false]]);
    assert.equal(f.sent.filter(value => value.action === 'closed').length, 2);
    assert.equal(f.publisher.snapshot().closed, true);
    assert.equal(endpoint.closed, true);
    assert.deepEqual(f.errors, []);
  });

  test(`${mode}: publisher Stop must still surface failed native retirement`, async () => {
    const f = fixture({ mode });
    await f.publisher.receive(f.watch('first'));
    await f.publisher.receive(f.watch('second'));
    const failure = new Error('Owned native engine failed to close.');
    f.endpoints[0].setDemand = async () => { throw failure; };
    await assert.rejects(f.publisher.close(), error => error instanceof AggregateError &&
      error.errors.includes(failure));
    assert.equal(f.publisher.snapshot().closed, false);
    assert.equal(f.publisher.snapshot().pipelines.length, 1);
  });
}

test('roster departure and source replacement cannot retain an old subscription', async () => {
  const { publisher, endpoints, watch } = fixture();
  const request = watch('a');
  await publisher.receive(request);
  await assert.rejects(publisher.receive({ ...request, sourceInstanceId: randomUUID() }));
  await publisher.setParticipants([]);
  assert.equal(endpoints[0].closed, true);
  await publisher.close();
});
