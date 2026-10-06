'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { NativeSfuTransport } = require('../runtime/nativeSfuTransport.cjs');
const { NativeRtcCommands } = require('../runtime/nativeRtcCommands.cjs');

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const source = (sourceId = 1) => ({ sourceId, shareId: `screen-${sourceId}`, syncGroup: `group-${sourceId}`,
  maxBitrateBps: 20000000, maxFramerate: 120 });
function fixture(options = {}) {
  const calls = [], errors = [], sources = new Map();
  let removeFailures = options.removeFailures ?? 0, closeFailures = options.closeFailures ?? 0;
  const broker = {
    registerSource(value) { calls.push(['register', value]); sources.set(value.sourceId, { ...value }); return value; },
    async publish(id, settings) {
      calls.push(['publish', id, settings]);
      if (options.publishGate) await options.publishGate.promise;
      if (!sources.has(id)) throw new DOMException('Source retired before publication.', 'AbortError');
      return { sourceId: id, producerId: 100 + id, shareId: sources.get(id).shareId, kind: 'video',
        syncGroup: sources.get(id).syncGroup, serverProducerId: `server-${id}`, enabled: false };
    },
    async removeSource(id) {
      calls.push(['remove', id]);
      if (options.removeGate) await options.removeGate.promise;
      if (removeFailures-- > 0) throw new Error('Producer retirement failed.');
      sources.delete(id);
    },
    handleNativeEvent(event) { calls.push(['event', event]); return options.onEvent?.(event) ?? true; },
    async close() {
      calls.push(['close']);
      if (closeFailures-- > 0) throw new Error('Server resource cleanup failed.');
      sources.clear();
    },
    async finishAfterEngineClose(proof) {
      calls.push(['proof', proof]);
      if (options.finish) await options.finish(proof);
      sources.clear();
    },
  };
  const facade = new NativeSfuTransport(broker, (error, context) => {
    errors.push({ error, context });
    return options.onError?.(error, context);
  }, { timeoutMs: options.timeoutMs ?? 1000 });
  return { facade, broker, calls, errors, sources };
}

test('the common-Root SFU facade is inert and preserves explicit video settings without enabling publication', async () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  const settings = source();
  const opening = f.facade.addSource(settings);
  settings.maxBitrateBps = 1;
  settings.maxFramerate = 5;
  const result = await opening;
  assert.deepEqual(f.calls, [
    ['register', { sourceId: 1, shareId: 'screen-1', syncGroup: 'group-1' }],
    ['publish', 1, { maxBitrateBps: 20000000, maxFramerate: 120 }],
  ]);
  assert.equal(result.enabled, false);
  assert.equal(result.kind, 'video');
});

test('invalid, aborted and audio sources cannot allocate SFU resources through the video facade', async () => {
  const f = fixture(), abort = new AbortController();
  abort.abort();
  await assert.rejects(f.facade.addSource(source(), abort.signal), { name: 'AbortError' });
  for (const change of [
    { sourceId: 0 }, { shareId: '' }, { syncGroup: '\0' }, { maxBitrateBps: 0 },
    { maxFramerate: 241 }, { kind: 'audio' }, { mediaType: 'camera' },
  ]) await assert.rejects(f.facade.addSource({ ...source(), ...change }));
  assert.deepEqual(f.calls, []);
});

test('Abort starts exact producer retirement without waiting for a pending native publication', async () => {
  const publishGate = deferred(), f = fixture({ publishGate }), abort = new AbortController();
  const opening = f.facade.addSource(source(), abort.signal);
  const rejected = assert.rejects(opening, { name: 'AbortError' });
  await nextTurn();
  abort.abort();
  await nextTurn();
  assert.equal(f.calls.some(value => value[0] === 'remove' && value[1] === 1), true);
  assert.equal(f.facade.sources.has(1), true, 'the raw opening still owns a possible late publication');
  publishGate.resolve();
  await rejected;
  await f.facade.removeSource(1);
  assert.equal(f.facade.sources.size, 0);
  assert.deepEqual(f.errors, []);
});

test('removing one screen leaves the other publication and callback delivery intact', async () => {
  const f = fixture();
  await Promise.all([f.facade.addSource(source(1)), f.facade.addSource(source(2))]);
  await f.facade.removeSource(1);
  assert.equal(f.facade.sources.has(2), true);
  assert.equal(f.sources.has(2), true);
  const event = { type: 'request', target: 102, data: { callbackId: 1 } };
  assert.equal(f.facade.handleEvent(event), true);
  assert.equal(f.calls.at(-1)[1], event);
});

test('concurrent removal keeps the original retirement Promise and retries only actual failures', async () => {
  const removeGate = deferred(), f = fixture({ removeGate, removeFailures: 1 });
  await f.facade.addSource(source());
  const first = f.facade.removeSource(1), second = f.facade.removeSource(1);
  const rejected = Promise.all([assert.rejects(first, /retirement failed/), assert.rejects(second, /retirement failed/)]);
  await nextTurn();
  assert.equal(f.calls.filter(value => value[0] === 'remove').length, 1);
  removeGate.resolve();
  await rejected;
  assert.equal(f.facade.sources.has(1), true);
  await f.facade.removeSource(1);
  assert.equal(f.facade.sources.size, 0);
  assert.equal(f.calls.filter(value => value[0] === 'remove').length, 2);
});

test('closing prevents queued publications and preserves late callback processing for server cleanup', async () => {
  const f = fixture({ closeFailures: 1 });
  const opening = f.facade.addSource(source());
  const rejected = assert.rejects(opening, { name: 'AbortError' });
  await assert.rejects(f.facade.close(), /Server resource cleanup/);
  await rejected;
  assert.equal(f.calls.some(value => value[0] === 'publish'), false);
  assert.equal(f.facade.sources.size, 1);
  assert.equal(f.facade.handleEvent({ type: 'request', target: 12 }), true);
  await assert.rejects(f.facade.addSource(source(2)), /closed/);
  await f.facade.close();
  assert.equal(f.facade.sources.size, 0);
});

test('native callbacks are routed immediately while a publication still awaits its callback', async () => {
  const publishGate = deferred();
  const f = fixture({ publishGate, onEvent: () => { publishGate.resolve(); return true; } });
  const opening = f.facade.addSource(source());
  await nextTurn();
  assert.equal(f.facade.handleEvent({ type: 'request', target: 22 }), true);
  assert.equal((await opening).producerId, 101);
});

test('the facade forwards the actual engine proof and retains remote cleanup obligations after native retirement', async () => {
  let remoteFailure = true, nativeClosed = false;
  const engine = { request: async () => ({}), close: async () => { nativeClosed = true; } };
  const commands = new NativeRtcCommands(engine);
  const f = fixture({ finish: async proof => {
    await proof;
    commands.assertEngineClosed(engine);
    if (remoteFailure) throw new Error('Remote cleanup is still pending.');
  } });
  await f.facade.addSource(source());
  await assert.rejects(f.facade.finishAfterEngineClose(Promise.resolve({ closed: true })), /not been proven/);
  assert.equal(nativeClosed, false);
  const proof = commands.closeEngine();
  await assert.rejects(f.facade.finishAfterEngineClose(proof), /Remote cleanup/);
  assert.equal(f.calls.at(-1)[1], proof);
  assert.equal(f.facade.sources.size, 1);
  remoteFailure = false;
  await f.facade.finishAfterEngineClose(proof);
  assert.equal(f.facade.sources.size, 0);
});

test('a background abort-cleanup failure is reported with its original share and stays retryable', async () => {
  const publishGate = deferred(), f = fixture({ publishGate, removeFailures: 1 }), abort = new AbortController();
  const opening = f.facade.addSource(source(), abort.signal);
  const rejected = assert.rejects(opening, { name: 'AbortError' });
  await nextTurn();
  abort.abort();
  await nextTurn();
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].context.shareId, 'screen-1');
  assert.equal(f.facade.sources.has(1), true);
  publishGate.resolve();
  await rejected;
  await f.facade.removeSource(1);
  assert.equal(f.facade.sources.size, 0);
});

test('synchronous success-shaped broker returns cannot prove asynchronous publication or retirement', async () => {
  const f = fixture();
  f.broker.publish = () => ({ enabled: false });
  await assert.rejects(f.facade.addSource(source()), /actual Promise/);
  f.broker.removeSource = () => undefined;
  await assert.rejects(f.facade.removeSource(1), /actual Promise/);
  assert.equal(f.facade.sources.has(1), true);
});

test('SFU audio publication is opt-in and a fabricated readiness-shaped broker cannot enable the Root API', async () => {
  const f = fixture();
  assert.equal(f.facade.audioPublicationEnabled, false);
  assert.throws(() => { f.facade.audioPublicationEnabled = true; }, TypeError);
  await assert.rejects(f.facade.addAudioSource({ sourceId: 10, screenAudioShareId: 'screen-1',
    syncGroup: 'group-1', maxBitrateBps: 128000 }), /configured A\/V broker/u);
  for (const audioPublication of [true, 1, 'true']) {
    assert.throws(() => new NativeSfuTransport({
      ...f.broker, audioPublicationEnabled: true,
      registerAudioSource() {}, async publishAudio() {}, async removeAudioSource() {}, async rebindAudioSource() {},
    }, () => {}, { audioPublication }), /complete native SFU broker/u);
  }
  assert.deepEqual(f.calls, []);
});

test('audio-only facade operations cannot retire or reinterpret a video source', async () => {
  const f = fixture();
  await f.facade.addSource(source());
  await assert.rejects(f.facade.removeAudioSource(1), /own source ID/u);
  await assert.rejects(f.facade.rebindAudioSource(1, { screenAudioShareId: 'screen-1', syncGroup: 'group-1' }), /own PCM source/u);
  await assert.rejects(f.facade.rebindAudioSource(1, {}, {}), /cancellation signal/u);
  assert.equal(f.sources.has(1), true);
  await f.facade.close();
});

test('invalid facade deadlines cannot turn a missing target into an unbounded rebind reservation', () => {
  const f = fixture();
  for (const timeoutMs of [0, -1, 60001, 0.5, NaN, Infinity, '20']) {
    assert.throws(() => new NativeSfuTransport(f.broker, () => {}, { timeoutMs }), /complete native SFU broker/u);
  }
});

for (const finish of [false, true]) test(`${finish ? 'engine finish' : 'close'} retains a raw source opening after its bounded drain expires`, async () => {
  const publishGate = deferred(), f = fixture({ publishGate, timeoutMs: 20 });
  const opening = f.facade.addSource(source()), rejected = assert.rejects(opening, { name: 'AbortError' });
  await nextTurn();
  const drain = () => finish ? f.facade.finishAfterEngineClose(Promise.resolve()) : f.facade.close();
  await assert.rejects(drain(), /source work is still pending/u);
  assert.equal(f.facade.sources.has(1), true);
  assert.ok(f.facade.sources.get(1).opening);
  publishGate.resolve();
  await rejected;
  await drain();
  assert.equal(f.facade.sources.size, 0);
});

test('a timed-out source retirement keeps its original raw Promise and never replays the broker removal', async () => {
  const removeGate = deferred(), f = fixture({ removeGate, timeoutMs: 20 });
  await f.facade.addSource(source());
  await assert.rejects(f.facade.removeSource(1), /retirement is still pending/u);
  const raw = f.facade.sources.get(1).retiring;
  await assert.rejects(f.facade.removeSource(1), /retirement is still pending/u);
  assert.equal(f.facade.sources.get(1).retiring, raw);
  assert.equal(f.calls.filter(value => value[0] === 'remove').length, 1);
  removeGate.resolve();
  await f.facade.removeSource(1);
  assert.equal(f.facade.sources.size, 0);
});
