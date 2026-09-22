'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NativeP2pTransport } = require('../runtime/nativeP2pTransport.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const source = (sourceId = 10) => ({
  sourceId, shareId: `screen-${sourceId}`, syncGroup: 'call-group',
  width: 1920, height: 1080, maxBitrateBps: 30000000, maxFramerate: 120,
});
const audioSource = (sourceId = 20, screenAudioShareId = 'screen-10') => ({
  sourceId, screenAudioShareId, syncGroup: 'call-group', maxBitrateBps: 128000,
});
function fixture({ connectGate, publishGate, audioPublishGate, audioPublication = false,
  rebindGate, rebindResult = result => result, timeoutMs = 100, preparePeer = null } = {}) {
  const calls = [], registered = new Set(), audio = new Set(), connected = new Set(), errors = [];
  const metadata = new Map(), audioPublications = [], liveAudio = new Map();
  let failRemove = false, failClose = false, closed = false;
  const broker = {
    controlVersion: audioPublication ? 2 : 1,
    audio: audioPublication ? {} : null,
    registerSource(value) { calls.push(['register', value]); registered.add(value.sourceId); metadata.set(value.sourceId, value); },
    registerAudioSource(value) {
      calls.push(['register-audio', value]);
      registered.add(value.sourceId);
      audio.add(value.sourceId);
      metadata.set(value.sourceId, value);
    },
    async connect(id, configuration) {
      calls.push(['connect', id, configuration]);
      connected.add(id);
      if (connectGate) await connectGate;
      if (closed || !connected.has(id)) throw new DOMException('Peer was retired', 'AbortError');
      return 50;
    },
    async publish(id, peer, limits) {
      calls.push(['publish', id, peer, limits]);
      if (publishGate) await publishGate.promise;
      assert.ok(registered.has(id));
      assert.ok(connected.has(peer));
    },
    async publishAudio(id, peer, limits) {
      calls.push(['publish-audio', id, peer, limits]);
      if (audioPublishGate) await audioPublishGate.promise;
      assert.ok(audio.has(id));
      assert.ok(connected.has(peer));
      const publication = { ...metadata.get(id), peer };
      liveAudio.set(peer, publication);
      audioPublications.push(publication);
    },
    async rebindAudioSource(id, selection) {
      calls.push(['rebind-audio', id, selection]);
      for (const [peer, publication] of liveAudio) if (publication.sourceId === id) liveAudio.delete(peer);
      if (rebindGate) await rebindGate.promise;
      selection.signal.throwIfAborted();
      const result = { sourceId: id, screenAudioShareId: selection.screenAudioShareId, syncGroup: selection.syncGroup };
      metadata.set(id, result);
      return rebindResult(result);
    },
    async removeSource(id) {
      calls.push(['remove', id]);
      if (failRemove) throw new Error('Retirement failed');
      registered.delete(id);
      metadata.delete(id);
      for (const [peer, publication] of liveAudio) if (publication.sourceId === id) liveAudio.delete(peer);
      if (audio.delete(id)) audioPublishGate?.reject(new DOMException('Publication was cancelled', 'AbortError'));
      else publishGate?.reject(new DOMException('Publication was cancelled', 'AbortError'));
    },
    async closePeer(id) { calls.push(['close-peer', id]); connected.delete(id); },
    async close() {
      calls.push(['close']);
      if (failClose) throw new Error('Broker close failed');
      closed = true;
      registered.clear();
      audio.clear();
      liveAudio.clear();
      connected.clear();
    },
    async handleNativeEvent(event) { calls.push(['event', event]); },
    async finishAfterEngineClose(proof) { await proof; calls.push(['native-retired']); registered.clear(); connected.clear(); },
  };
  const transport = new NativeP2pTransport(broker, (error, context) => errors.push({ error, context }),
    { audioPublication, timeoutMs, preparePeer });
  return {
    transport, broker, calls, registered, audio, connected, errors, metadata, audioPublications, liveAudio,
    failRemove: value => { failRemove = value; }, failClose: value => { failClose = value; },
  };
}

test('a source is registered once and keeps its selected bitrate/FPS when a peer arrives later', async () => {
  const f = fixture();
  await f.transport.addSource(source());
  assert.equal(f.calls.filter(call => call[0] === 'publish').length, 0);
  await f.transport.connect('remote', { connectionId: 'pair', generation: 1 });
  assert.deepEqual(f.calls.find(call => call[0] === 'register')[1],
    { sourceId: 10, localShareId: 'screen-10', syncGroup: 'call-group' });
  assert.deepEqual(f.calls.find(call => call[0] === 'publish'),
    ['publish', 10, 'remote', { maxBitrateBps: 30000000, maxFramerate: 120 }]);
  await f.transport.close();
});

test('an existing peer receives every newly registered source with no browser transport', async () => {
  const f = fixture();
  await f.transport.connect('remote', { connectionId: 'pair', generation: 1 });
  await f.transport.addSource(source());
  await f.transport.addSource(source(11));
  assert.deepEqual(f.calls.filter(call => call[0] === 'publish').map(call => call[1]), [10, 11]);
  await f.transport.removeSource(10);
  assert.deepEqual([...f.registered], [11]);
  await f.transport.close();
});

test('startup bitrate preparation precedes both existing and concurrently added publications', async () => {
  const prepared = deferred();
  let peerId;
  const f = fixture({ preparePeer: async id => { peerId = id; await prepared.promise; } });
  await f.transport.addSource(source());
  const connecting = f.transport.connect('remote', { connectionId: 'pair', generation: 1 });
  await tick();
  const adding = f.transport.addSource(source(11));
  await tick();
  assert.equal(peerId, 50);
  assert.equal(f.calls.some(call => call[0] === 'publish'), false);
  prepared.resolve();
  await Promise.all([connecting, adding]);
  assert.ok(f.calls.some(call => call[0] === 'publish' && call[1] === 10));
  assert.ok(f.calls.some(call => call[0] === 'publish' && call[1] === 11));
  await f.transport.close();
});

test('failed peer preparation retires its exact peer without publishing or discarding other sources', async () => {
  const f = fixture({ preparePeer: async () => { throw new Error('Bitrate setup failed'); } });
  await f.transport.addSource(source());
  await assert.rejects(f.transport.connect('remote', { connectionId: 'pair', generation: 1 }), /Bitrate setup failed/);
  assert.equal(f.calls.some(call => call[0] === 'publish'), false);
  assert.equal(f.connected.size, 0);
  assert.equal(f.registered.has(10), true);
  await f.transport.close();
});

test('source removal retains failed native ownership and does not remove a different screen', async () => {
  const f = fixture();
  await f.transport.addSource(source());
  await f.transport.addSource(source(11));
  f.failRemove(true);
  await assert.rejects(f.transport.removeSource(10), /Retirement failed/u);
  assert.equal(f.transport.sources.has(10), true);
  assert.deepEqual([...f.registered], [10, 11]);
  f.failRemove(false);
  await f.transport.removeSource(10);
  assert.deepEqual([...f.registered], [11]);
  await f.transport.close();
});

test('abort cancels an in-flight publication immediately instead of waiting for source setup to finish', async () => {
  const publication = deferred(), f = fixture({ publishGate: publication }), abort = new AbortController();
  await f.transport.connect('remote', { connectionId: 'pair', generation: 1 });
  const adding = f.transport.addSource(source(), abort.signal);
  const rejected = assert.rejects(adding, error => error.name === 'AbortError');
  await tick();
  abort.abort();
  await rejected;
  assert.equal(f.registered.size, 0);
  assert.equal(f.transport.sources.size, 0);
  await f.transport.close();
});

test('peer closure during opening cannot publish a source to the late native result', async () => {
  const opening = deferred(), f = fixture({ connectGate: opening.promise });
  await f.transport.addSource(source());
  const connecting = f.transport.connect('remote', { connectionId: 'pair', generation: 1 });
  const rejected = assert.rejects(connecting);
  await tick();
  const closing = f.transport.closePeer('remote');
  opening.resolve();
  await rejected;
  await closing;
  assert.equal(f.calls.some(call => call[0] === 'publish'), false);
  assert.equal(f.connected.size, 0);
  await f.transport.close();
});

test('full engine proof clears transport metadata only after the broker independently accepts it', async () => {
  const f = fixture(), proof = deferred();
  await f.transport.addSource(source());
  f.failClose(true);
  await assert.rejects(f.transport.close(), /Broker close failed/u);
  assert.equal(f.transport.sources.size, 1);
  const retired = f.transport.finishAfterEngineClose(proof.promise);
  assert.equal(f.transport.sources.size, 1);
  proof.resolve({ closed: true });
  await retired;
  assert.equal(f.transport.sources.size, 0);
});

test('failed full-close proof preserves records, and missing quality cannot silently use broker defaults', async () => {
  const f = fixture();
  await assert.rejects(f.transport.addSource({ ...source(), maxFramerate: undefined }), /invalid/u);
  assert.equal(f.registered.size, 0);
  await f.transport.addSource(source());
  await assert.rejects(f.transport.finishAfterEngineClose(Promise.reject(new Error('Close not complete'))), /not complete/u);
  assert.equal(f.transport.sources.size, 1);
  f.failClose(false);
  await f.transport.close();
});

test('native events are forwarded unchanged to the broker that owns their peer generation', async () => {
  const f = fixture(), event = { type: 'peer.trackAdded', target: 50, data: { receiverId: 80 } };
  await f.transport.handleEvent(event);
  assert.deepEqual(f.calls[0], ['event', event]);
  await f.transport.close();
});

test('audio publication is explicitly opt-in and requires an A/V broker before any source is registered', async () => {
  const f = fixture();
  await f.transport.addSource(source());
  await assert.rejects(f.transport.addAudioSource(audioSource()), /configured A\/V broker/u);
  assert.equal(f.calls.some(call => call[0] === 'register-audio'), false);
  assert.throws(() => new NativeP2pTransport(f.broker, () => {}, { audioPublication: true }), /complete native P2P broker/u);
  assert.throws(() => new NativeP2pTransport(f.broker, () => {}, { audioPublication: 'true' }), /complete native P2P broker/u);
  await f.transport.close();
});

test('audio registration requires the exact active screen group and an explicit Opus bitrate without FPS', async () => {
  const f = fixture({ audioPublication: true });
  await assert.rejects(f.transport.addAudioSource(audioSource()), /explicit active screen/u);
  await f.transport.addSource(source());
  for (const invalid of [
    { ...audioSource(), screenAudioShareId: 'unregistered' },
    { ...audioSource(), syncGroup: 'another-group' },
    { ...audioSource(), maxBitrateBps: undefined },
    { ...audioSource(), maxBitrateBps: 510001 },
    { ...audioSource(), maxFramerate: 120 },
    { ...audioSource(), sourceId: 10 },
  ]) await assert.rejects(f.transport.addAudioSource(invalid), /explicit active screen/u);
  assert.equal(f.audio.size, 0);
  await f.transport.close();
});

test('a later peer receives the associated video before disabled audio publication with its selected bitrate', async () => {
  const f = fixture({ audioPublication: true });
  await f.transport.addSource(source());
  await f.transport.addAudioSource(audioSource());
  assert.deepEqual(f.calls.find(call => call[0] === 'register-audio')[1], {
    sourceId: 20, screenAudioShareId: 'screen-10', syncGroup: 'call-group',
  });
  assert.equal(f.calls.some(call => call[0] === 'publish-audio'), false);
  await f.transport.connect('remote', { connectionId: 'pair', generation: 1 });
  const audioCall = f.calls.findIndex(call => call[0] === 'publish-audio');
  assert.ok(f.calls.findIndex(call => call[0] === 'publish') < audioCall);
  assert.deepEqual(f.calls[audioCall], ['publish-audio', 20, 'remote', { maxBitrateBps: 128000 }]);
  assert.equal(f.calls.some(call => /Enabled|epoch|capture/iu.test(call[0])), false);
  await f.transport.close();
});

test('audio publication waits for the associated video publication Promise, not just peer creation', async () => {
  const video = deferred(), f = fixture({ audioPublication: true, publishGate: video });
  await f.transport.addSource(source());
  await f.transport.addAudioSource(audioSource());
  const connecting = f.transport.connect('remote', { connectionId: 'pair', generation: 1 });
  await tick();
  assert.equal(f.calls.some(call => call[0] === 'publish-audio'), false);
  video.resolve();
  await connecting;
  assert.equal(f.calls.filter(call => call[0] === 'publish-audio').length, 1);
  await f.transport.close();
});

test('only one retained audio source is admitted, and removing another screen does not affect its association', async () => {
  const f = fixture({ audioPublication: true });
  await f.transport.addSource(source());
  await f.transport.addSource(source(11));
  await f.transport.addAudioSource(audioSource());
  await assert.rejects(f.transport.addAudioSource(audioSource(21, 'screen-11')), /explicit active screen/u);
  await f.transport.removeSource(11);
  assert.deepEqual([...f.audio], [20]);
  await assert.rejects(f.transport.removeAudioSource(10), /own source ID/u);
  await f.transport.removeAudioSource(20);
  assert.deepEqual([...f.registered], [10]);
  await f.transport.addAudioSource(audioSource(21));
  await f.transport.close();
});

test('removing the associated screen retires audio first and retains both records when that retirement fails', async () => {
  const f = fixture({ audioPublication: true });
  await f.transport.addSource(source());
  await f.transport.addAudioSource(audioSource());
  f.failRemove(true);
  await assert.rejects(f.transport.removeSource(10), /Retirement failed/u);
  assert.deepEqual(f.calls.filter(call => call[0] === 'remove'), [['remove', 20]]);
  assert.equal(f.transport.sources.size, 2);
  f.failRemove(false);
  await f.transport.removeSource(10);
  assert.deepEqual(f.calls.filter(call => call[0] === 'remove').slice(-2), [['remove', 20], ['remove', 10]]);
  assert.equal(f.transport.sources.size, 0);
  await f.transport.close();
});

test('aborting pending audio publication retires only audio without waiting for the publication result', async () => {
  const publication = deferred(), f = fixture({ audioPublication: true, audioPublishGate: publication });
  const abort = new AbortController();
  await f.transport.connect('remote', { connectionId: 'pair', generation: 1 });
  await f.transport.addSource(source());
  const adding = f.transport.addAudioSource(audioSource(), abort.signal);
  const rejected = assert.rejects(adding, error => error.name === 'AbortError');
  await tick();
  abort.abort();
  await rejected;
  assert.deepEqual([...f.registered], [10]);
  assert.equal(f.transport.sources.get(10).active, true);
  assert.equal(f.audio.size, 0);
  await f.transport.close();
});

test('rebind capability is optional for basic send and required only by an explicit reassociation', async () => {
  const f = fixture({ audioPublication: true });
  delete f.broker.rebindAudioSource;
  await f.transport.addSource(source());
  await f.transport.addAudioSource(audioSource());
  await assert.rejects(f.transport.rebindAudioSource(20, {
    screenAudioShareId: 'screen-10', syncGroup: 'call-group',
  }), /broker capability/u);
  assert.equal(f.transport.sources.get(20).active, true);
  await f.transport.close();
});

test('an explicit rebind preserves the PCM source and deliberately publishes only after the real broker acknowledgement', async () => {
  const gate = deferred(), f = fixture({ audioPublication: true, rebindGate: gate });
  await f.transport.addSource(source());
  await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
  await f.transport.addAudioSource(audioSource());
  await f.transport.connect('remote', { connectionId: 'pair', generation: 1 });
  const moving = f.transport.rebindAudioSource(20, { screenAudioShareId: 'screen-11', syncGroup: 'second-group' });
  await tick();
  assert.equal(f.liveAudio.size, 0);
  assert.equal(f.transport.sources.get(20).shareId, 'screen-10');
  assert.equal(f.audioPublications.length, 1);
  gate.resolve();
  assert.deepEqual(await moving, { sourceId: 20, screenAudioShareId: 'screen-11', syncGroup: 'second-group' });
  assert.deepEqual(f.liveAudio.get('remote'), {
    sourceId: 20, screenAudioShareId: 'screen-11', syncGroup: 'second-group', peer: 'remote',
  });
  assert.equal(f.calls.filter(call => call[0] === 'register-audio').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
  assert.equal(f.transport.sources.size, 3);
  await f.transport.close();
});

test('new peers skip an in-flight association and all receive only its deliberately republished target group', async () => {
  const gate = deferred(), f = fixture({ audioPublication: true, rebindGate: gate });
  await f.transport.addSource(source());
  await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
  await f.transport.addAudioSource(audioSource());
  const moving = f.transport.rebindAudioSource(20, { screenAudioShareId: 'screen-11', syncGroup: 'second-group' });
  await tick();
  await f.transport.connect('during-retirement', {});
  assert.equal(f.audioPublications.length, 0);
  const publishing = deferred(), original = f.broker.publishAudio;
  f.broker.publishAudio = async (...args) => { await publishing.promise; return original(...args); };
  gate.resolve();
  await tick();
  await f.transport.connect('during-republish', {});
  publishing.resolve();
  await moving;
  assert.deepEqual([...f.liveAudio.keys()].sort(), ['during-republish', 'during-retirement']);
  assert.ok(f.audioPublications.every(publication => publication.screenAudioShareId === 'screen-11'
    && publication.syncGroup === 'second-group'));
  await f.transport.close();
});

test('target setup is reserved before native registration so an arriving peer cannot receive the old audio group', async () => {
  const f = fixture({ audioPublication: true });
  await f.transport.addSource(source());
  await f.transport.addAudioSource(audioSource());
  const moving = f.transport.rebindAudioSource(20, { screenAudioShareId: 'screen-11', syncGroup: 'second-group' });
  await f.transport.connect('early', {});
  assert.equal(f.audioPublications.length, 0);
  assert.equal(f.calls.some(call => call[0] === 'rebind-audio'), false);
  await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
  await moving;
  assert.equal(f.liveAudio.get('early').syncGroup, 'second-group');
  await f.transport.close();
});

test('a peer already waiting for its old associated video cannot publish stale audio after rebind starts', async () => {
  const video = deferred(), f = fixture({ audioPublication: true, publishGate: video });
  await f.transport.addSource(source());
  await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
  await f.transport.addAudioSource(audioSource());
  const connecting = f.transport.connect('remote', {});
  await tick();
  const moving = f.transport.rebindAudioSource(20, { screenAudioShareId: 'screen-11', syncGroup: 'second-group' });
  await tick();
  video.resolve();
  await Promise.all([connecting, moving]);
  assert.ok(f.audioPublications.length > 0);
  assert.ok(f.audioPublications.every(publication => publication.syncGroup === 'second-group'));
  assert.equal(f.calls.some(call => call[0] === 'close-peer'), false);
  await f.transport.close();
});

test('cancelling a native publication from the old association cannot close its concurrently connecting video peer', async () => {
  const publication = deferred(), started = deferred(), f = fixture({ audioPublication: true });
  await f.transport.addSource(source());
  await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
  await f.transport.addAudioSource(audioSource());
  const publish = f.broker.publishAudio, rebind = f.broker.rebindAudioSource;
  let first = true;
  f.broker.publishAudio = async (...args) => {
    if (first) { first = false; started.resolve(); await publication.promise; }
    return publish(...args);
  };
  f.broker.rebindAudioSource = (...args) => {
    publication.reject(new DOMException('Old sender was retired.', 'AbortError'));
    return rebind(...args);
  };
  const connecting = f.transport.connect('remote', {});
  await started.promise;
  await f.transport.rebindAudioSource(20, { screenAudioShareId: 'screen-11', syncGroup: 'second-group' });
  await connecting;
  assert.equal(f.liveAudio.get('remote').syncGroup, 'second-group');
  assert.equal(f.calls.some(call => call[0] === 'close-peer'), false);
  assert.equal(f.connected.has('remote'), true);
  await f.transport.close();
});

test('rebind rejects duplicate selections, wrong groups and invalid signals without silently changing ownership', async () => {
  const gate = deferred(), f = fixture({ audioPublication: true, rebindGate: gate });
  await f.transport.addSource(source());
  await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
  await f.transport.addAudioSource(audioSource());
  await assert.rejects(f.transport.rebindAudioSource(10, {
    screenAudioShareId: 'screen-11', syncGroup: 'second-group',
  }), /active source/u);
  await assert.rejects(f.transport.rebindAudioSource(20, {
    screenAudioShareId: 'screen-11', syncGroup: 'wrong',
  }), /exact selected/u);
  await assert.rejects(f.transport.rebindAudioSource(20, {
    screenAudioShareId: 'screen-11', syncGroup: 'second-group',
  }, {}), /signal/u);
  const moving = f.transport.rebindAudioSource(20, { screenAudioShareId: 'screen-11', syncGroup: 'second-group' });
  await assert.rejects(f.transport.rebindAudioSource(20, {
    screenAudioShareId: 'screen-10', syncGroup: 'call-group',
  }), /active source/u);
  gate.resolve();
  await moving;
  await f.transport.close();
});

for (const stop of ['audio', 'old-video', 'target-video', 'close']) {
  test(`${stop} cancellation drains a raw rebind without awaiting its own catch-cleanup wrapper`, async () => {
    const gate = deferred(), f = fixture({ audioPublication: true, rebindGate: gate });
    await f.transport.addSource(source());
    await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
    await f.transport.addAudioSource(audioSource());
    await f.transport.connect('remote', {});
    const moving = f.transport.rebindAudioSource(20, { screenAudioShareId: 'screen-11', syncGroup: 'second-group' });
    const rejected = assert.rejects(moving);
    await tick();
    const stopping = stop === 'close' ? f.transport.close()
      : stop === 'audio' ? f.transport.removeAudioSource(20)
        : f.transport.removeSource(stop === 'old-video' ? 10 : 11);
    await tick();
    assert.equal(f.calls.some(call => call[0] === 'rebind-audio' && call[2].signal.aborted), true);
    gate.resolve();
    await stopping;
    await rejected;
    assert.equal(f.transport.sources.has(20), false);
    assert.equal(f.liveAudio.size, 0);
    if (stop !== 'close') {
      assert.equal(f.transport.sources.has(stop === 'old-video' ? 11 : 10), true);
      assert.equal(f.calls.some(call => call[0] === 'close-peer'), false);
    }
    await f.transport.close();
  });
}

test('a mismatched native acknowledgement retires only audio and never republishes either association', async () => {
  const f = fixture({ audioPublication: true, rebindResult: result => ({ ...result, sourceId: 999 }) });
  await f.transport.addSource(source());
  await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
  await f.transport.addAudioSource(audioSource());
  await f.transport.connect('remote', {});
  await assert.rejects(f.transport.rebindAudioSource(20, {
    screenAudioShareId: 'screen-11', syncGroup: 'second-group',
  }), /acknowledgement/u);
  assert.deepEqual([...f.registered], [10, 11]);
  assert.equal(f.audioPublications.length, 1);
  assert.equal(f.liveAudio.size, 0);
  assert.equal(f.connected.has('remote'), true);
  await f.transport.close();
});

test('failed republishing does not withdraw either video or close a peer', async () => {
  const f = fixture({ audioPublication: true });
  await f.transport.addSource(source());
  await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
  await f.transport.addAudioSource(audioSource());
  await f.transport.connect('remote', {});
  f.broker.publishAudio = async () => { throw new Error('Modeled replacement sender failed.'); };
  await assert.rejects(f.transport.rebindAudioSource(20, {
    screenAudioShareId: 'screen-11', syncGroup: 'second-group',
  }), /publication failed/u);
  assert.deepEqual([...f.registered], [10, 11]);
  assert.equal(f.liveAudio.size, 0);
  assert.equal(f.connected.has('remote'), true);
  await f.transport.close();
});

test('a pending raw broker rebind survives bounded cleanup failure and is retired only after its late result', async () => {
  const gate = deferred(), f = fixture({ audioPublication: true, rebindGate: gate, timeoutMs: 15 });
  await f.transport.addSource(source());
  await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
  await f.transport.addAudioSource(audioSource());
  await f.transport.connect('remote', {});
  await assert.rejects(f.transport.rebindAudioSource(20, {
    screenAudioShareId: 'screen-11', syncGroup: 'second-group',
  }), /retirement failed/u);
  const retained = f.transport.sources.get(20);
  assert.ok(retained.rebind.raw);
  assert.equal(retained.active, false);
  await assert.rejects(f.transport.removeAudioSource(20), /source ownership is retained/u);
  assert.equal(f.transport.sources.get(20), retained);
  assert.equal(f.audioPublications.length, 1);
  gate.resolve();
  await tick();
  await f.transport.removeAudioSource(20);
  assert.deepEqual([...f.registered], [10, 11]);
  assert.equal(f.liveAudio.size, 0);
  await f.transport.close();
});

test('facade close retains pending rebind metadata boundedly instead of erasing its raw operation', async () => {
  const gate = deferred(), f = fixture({ audioPublication: true, rebindGate: gate, timeoutMs: 15 });
  await f.transport.addSource(source());
  await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
  await f.transport.addAudioSource(audioSource());
  const moving = f.transport.rebindAudioSource(20, { screenAudioShareId: 'screen-11', syncGroup: 'second-group' });
  const rejected = assert.rejects(moving);
  await tick();
  await assert.rejects(f.transport.close(), /source ownership is retained/u);
  assert.ok(f.transport.sources.get(20).rebind.raw);
  assert.equal(f.transport.sources.get(20).active, false);
  gate.resolve();
  await rejected;
  await f.transport.close();
  assert.equal(f.transport.sources.size, 0);
  assert.equal(f.audioPublications.length, 0);
});

test('audio Stop during deliberate republish does not wait for an unrelated joining peer to finish opening', async () => {
  const opening = deferred(), f = fixture({ audioPublication: true, connectGate: opening.promise });
  await f.transport.addSource(source());
  await f.transport.addSource({ ...source(11), syncGroup: 'second-group' });
  await f.transport.addAudioSource(audioSource());
  const connecting = f.transport.connect('slow-peer', {});
  const moving = f.transport.rebindAudioSource(20, { screenAudioShareId: 'screen-11', syncGroup: 'second-group' });
  const rejected = assert.rejects(moving);
  await tick();
  assert.equal(f.transport.sources.get(20).rebind.committed, true);
  await f.transport.removeAudioSource(20);
  await rejected;
  assert.deepEqual([...f.registered], [10, 11]);
  assert.ok(f.transport.peers.get('slow-peer').opening);
  opening.resolve();
  await connecting;
  assert.equal(f.liveAudio.size, 0);
  await f.transport.close();
});
