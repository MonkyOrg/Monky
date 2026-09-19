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
  const endpoints = [], sent = [], errors = [];
  const source = { shareId: 'owned-screen', instanceId: randomUUID(), audio: false,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  const publisher = new NativeScreenPublisher({
    sessionId: 'publisher', channelId: 'room', mode, source, iceServers: [],
    send: async value => { sent.push(value); }, onError: error => errors.push(error), onState() {},
    createEndpoint(options) {
      const endpoint = {
        options, ready: readiness?.promise ?? Promise.resolve(), demand: 0, closed: false, peers: new Set(), controls: [],
        async setDemand(count) {
          this.demand = count;
          if (count === 0) { if (closeGate) await closeGate.promise; this.closed = true; this.peers.clear(); }
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
  return { publisher, endpoints, sent, errors, watch, stop, source };
}

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

test('roster departure and source replacement cannot retain an old subscription', async () => {
  const { publisher, endpoints, watch } = fixture();
  const request = watch('a');
  await publisher.receive(request);
  await assert.rejects(publisher.receive({ ...request, sourceInstanceId: randomUUID() }));
  await publisher.setParticipants([]);
  assert.equal(endpoints[0].closed, true);
  await publisher.close();
});
