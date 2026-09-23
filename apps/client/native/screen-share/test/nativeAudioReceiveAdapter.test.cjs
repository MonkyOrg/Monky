'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NativeRtcCommands } = require('../runtime/nativeRtcCommands.cjs');
const { NativeAudioOutputOwner, nativeAudioOutputReceiveEpoch } = require('../runtime/nativeAudioOutputOwner.cjs');
const { NativeAudioReceiveAdapter, isNativeAudioReceiveAdapterForEngine } = require('../runtime/nativeAudioReceiveAdapter.cjs');
const { NativeSfuBroker } = require('../runtime/nativeSfuBroker.cjs');
const contract = require('../runtime/nativeRtc/engine/contract.json');

function fixture({ calibrated = true, maximumReceivers = 64 } = {}) {
  const calls = [], errors = [];
  const abort = new AbortController();
  let owner, current = true;
  const engine = {
    async request(_id, operation, target, data) {
      calls.push({ operation, target, data });
      if (operation === 'audio.configureOutput') return { epoch: data.epoch, sampleRate: 48000, channels: 2 };
      if (operation === 'audio.stopOutput') return {};
      assert.fail(`Unexpected output operation ${operation}`);
    },
    grantAudioCredits() {},
    audioClockProbe: data => ({ ...data, rtcBeforeUs: 1000, rtcAfterUs: 1001 }),
    calibrateAudioClock: data => ({ epoch: data.epoch, calibrationId: data.probeId, offsetUs: 0, uncertaintyUs: 1 }),
    setAudioOutputFeedback() {},
    async close() { return { closed: true }; },
  };
  const commands = new NativeRtcCommands(engine);
  owner = new NativeAudioOutputOwner(engine, commands, {
    async start(config, signal) {
      await owner.configureOutput(config);
      signal.throwIfAborted();
      if (calibrated) {
        owner.probe({ epoch: config.epoch, probeId: 1 });
        owner.calibrate({ epoch: config.epoch, probeId: 1, rendererBeforeUs: 1000, rendererAfterUs: 1001 });
      }
      return config;
    },
    async stop(epoch) { calls.push({ operation: 'renderer.stop', epoch }); },
    async enqueue() {},
  }, (error, context) => errors.push({ error, context }));
  const adapter = new NativeAudioReceiveAdapter({
    engine, output: owner, callId: 'call', channelId: 'channel', maximumReceivers,
    isCurrent: scope => current && scope.remoteSessionId === 'remote' && scope.connectionId === 'connection' && scope.generation === 1,
  });
  const context = (selection = null) => ({
    engine, callId: 'call', channelId: 'channel', remoteSessionId: 'remote',
    connectionId: 'connection', generation: 1, peerId: 10, signal: abort.signal,
    ...(selection ? { reason: 'receiver', selection } : { reason: 'description', side: 'remote', descriptionType: 'offer' }),
  });
  return { owner, adapter, engine, commands, calls, errors, context, abort,
    setCurrent: value => { current = value; } };
}

const selection = (receiverId = 20) => ({
  peerId: 10, receiverId, observedEpoch: 7, publisherSessionId: 'remote', connectionId: 'connection', generation: 1,
  kind: 'audio', shareId: 'screen-one', screenAudioShareId: 'screen-one', syncGroup: 'source-group',
  publicationId: 30, publicationVersion: 1, metadataVersion: 2, watchVersion: 3, subscriptionId: 4, volume: 1,
  binding: { trackId: `track-${receiverId}`, mid: `${receiverId}`, streamIds: ['source-group'] },
});
const receipt = receiverId => ({ receiverId, receiverEpoch: 8, enabled: true, requestedEnabled: true });

test('receive adapter construction and imports are inert and require a genuine same-engine owner', async () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.adapter.prepareReceive(f.context()), /Select, start and calibrate/u);
  assert.deepEqual(f.calls, []);
  assert.throws(() => new NativeAudioReceiveAdapter({ engine: {}, output: f.owner,
    callId: 'call', channelId: 'channel', isCurrent: () => true }), /same-engine/u);
  assert.throws(() => new NativeAudioReceiveAdapter({ engine: f.engine, output: { getStats: () => ({ ready: true }) },
    callId: 'call', channelId: 'channel', isCurrent: () => true }), /same-engine/u);
});

test('SFU audio admits the actual encoded revision7 contract without weakening any audio or ownership capability', () => {
  const f = fixture();
  f.engine.respond = () => assert.fail('Capability admission must not open native media.');
  f.engine.cancel = () => assert.fail('Capability admission must not issue native operations.');
  const capabilities = { abiVersion: 2, contractRevision: 7, audioExtensionVersion: 1,
    audioAvailable: true, ...contract.requiredCompiledCapabilities };
  const options = {
    engine: f.engine, commands: f.commands, audio: f.adapter, callId: 'call', channelId: 'channel',
    connectionId: 'connection', generation: 1, publisherSessionId: 'publisher',
    screenSessionId: '12345678-1234-4234-8234-123456789012',
    routes: { registerConsumer() {}, removeConsumer() {} },
    rpc: () => assert.fail('Capability admission must not contact the server.'),
    isCurrent: () => true, isWatchCurrent: () => false, isAudioWatchCurrent: () => false,
    isAudioPublicationCurrent: () => false, onError: error => { throw error; },
    nativeCapabilities: capabilities,
  };
  assert.equal(new NativeSfuBroker(options).audioPublicationEnabled, true);
  for (const revision of [6, 8]) assert.throws(() => new NativeSfuBroker({
    ...options, nativeCapabilities: { ...capabilities, contractRevision: revision },
  }), /revision7 capabilities/);
  for (const field of Object.keys(capabilities)) {
    const invalid = { ...capabilities };
    delete invalid[field];
    assert.throws(() => new NativeSfuBroker({ ...options, nativeCapabilities: invalid }), /revision7 capabilities/);
  }
  assert.deepEqual(f.calls, []);
});

test('only the actual selected, configured and calibrated output yields an attempt-specific expected epoch', async () => {
  const f = fixture();
  await f.owner.start('explicit-selected-output');
  const context = f.context(), proof = await f.adapter.prepareReceive(context);
  assert.deepEqual(Object.keys(proof), []);
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(f.adapter.assertReceiveReady(proof, context), undefined);
  assert.equal(f.adapter.expectedOutputEpoch(proof, context), 1);
  assert.equal(nativeAudioOutputReceiveEpoch(f.owner, f.engine), 1);
  assert.equal(f.calls.filter(call => call.operation === 'audio.configureOutput').length, 1);
  assert.equal(f.calls.some(call => call.operation.startsWith('peer.')), false);
  await f.owner.stop();
});

test('observed readiness without a real calibration cannot authorize receive admission', async () => {
  const f = fixture({ calibrated: false });
  await f.owner.start('selected');
  assert.equal(f.owner.getStats().ready, true);
  assert.equal(nativeAudioOutputReceiveEpoch(f.owner, f.engine), null);
  await assert.rejects(f.adapter.prepareReceive(f.context()), /calibrate/u);
  await f.owner.stop();
});

test('public stats and epoch method overrides cannot forge private output readiness', async () => {
  const f = fixture(), stats = f.owner.getStats;
  f.owner.getStats = () => ({ ready: true, nativeConfigured: true, calibrationId: 1, activeEpoch: 99 });
  f.owner.receiveEpoch = () => 99;
  await assert.rejects(f.adapter.prepareReceive(f.context()), /Select, start/u);
  f.owner.getStats = stats;
  await f.owner.start('selected');
  const context = f.context(), proof = await f.adapter.prepareReceive(context);
  assert.equal(f.adapter.expectedOutputEpoch(proof, context), 1);
  await f.owner.stop();
});

test('retirement and replacement invalidate every old preparation without turning the proof into a native lease', async () => {
  const f = fixture();
  await f.owner.start('first');
  const context = f.context(), first = await f.adapter.prepareReceive(context);
  f.owner.handleNativeEvent({ type: 'audio.outputInvalidated', target: 0, data: { epoch: 1, reason: 'mixer-failure' } });
  assert.throws(() => f.adapter.expectedOutputEpoch(first, context), /replaced/u);
  await f.owner.stop(1);
  await f.owner.start('second');
  const second = await f.adapter.prepareReceive(context);
  assert.equal(f.adapter.expectedOutputEpoch(second, context), 2);
  assert.throws(() => f.adapter.assertReceiveReady(first, context), /replaced/u);
  await f.owner.stop(2);
});

test('proofs cannot move between adapters, receive reasons, peer generations, sides or cancellation signals', async () => {
  const f = fixture(), other = fixture();
  await f.owner.start('selected');
  const context = f.context(), proof = await f.adapter.prepareReceive(context);
  assert.throws(() => other.adapter.assertReceiveReady(proof, other.context()), /original preparation/u);
  for (const change of [{ peerId: 11 }, { side: 'local' }, { descriptionType: 'answer' },
    { signal: new AbortController().signal }, { generation: 2 }, { channelId: 'other' },
    { reason: 'receiver', selection: selection() }]) {
    assert.throws(() => f.adapter.assertReceiveReady(proof, { ...context, ...change }));
  }
  assert.throws(() => f.adapter.assertReceiveReady({}, context), /original preparation/u);
  f.abort.abort();
  assert.throws(() => f.adapter.assertReceiveReady(proof, context), error => error.name === 'AbortError');
  await f.owner.stop();
});

test('a no-longer-current call scope rejects otherwise valid preparations and bindings', async () => {
  const f = fixture();
  await f.owner.start('selected');
  const chosen = selection(), context = f.context(chosen), proof = await f.adapter.prepareReceive(context);
  f.setCurrent(false);
  await assert.rejects(f.adapter.prepareReceive(context), /current call/u);
  assert.throws(() => f.adapter.bindReceiver({ ...chosen, receiverEpoch: 8 }, receipt(20), proof), /current call/u);
  assert.equal(f.adapter.getStats().receivers, 0);
  await f.owner.stop();
});

test('receiver binding requires the original watched screen and actual enabled receipt; returned diagnostics are immutable', async () => {
  const f = fixture();
  await f.owner.start('selected');
  const chosen = selection(), context = f.context(chosen), proof = await f.adapter.prepareReceive(context);
  const confirmed = { ...chosen, receiverEpoch: 8 };
  assert.equal(f.adapter.onReceiverVolume(chosen, { receiverId: 20, receiverEpoch: 7, volume: 1 }), false);
  assert.throws(() => f.adapter.bindReceiver(confirmed, { ...receipt(20), enabled: false }, proof), /acknowledgement/u);
  assert.throws(() => f.adapter.bindReceiver({ ...confirmed, watchVersion: 4 }, receipt(20), proof), /acknowledgement/u);
  assert.throws(() => f.adapter.bindReceiver({ ...confirmed, screenAudioShareId: 'screen-two' }, receipt(20), proof), /selected screen/u);
  assert.equal(f.adapter.bindReceiver(confirmed, receipt(20), proof), true);
  const state = f.adapter.getStats();
  assert.equal(state.receivers, 1);
  assert.equal(state.bindings[0].outputEpoch, 1);
  assert.throws(() => state.bindings[0].binding.streamIds.push('other'), TypeError);
  assert.equal(f.adapter.revokeReceiver({ ...confirmed, receiverEpoch: 9 }, 'stale'), false);
  assert.equal(f.adapter.getStats().receivers, 1);
  assert.equal(f.adapter.revokeReceiver(confirmed, 'watch-stopped'), true);
  assert.equal(f.adapter.getStats().receivers, 0);
  assert.equal(f.owner.getStats().ready, true);
  await f.owner.stop();
});

test('mutating a pending selection cannot rewrite its original output preparation', async () => {
  const f = fixture();
  await f.owner.start('selected');
  const chosen = selection(), context = f.context(chosen), proof = await f.adapter.prepareReceive(context);
  chosen.binding.streamIds.push('foreign-group');
  assert.throws(() => f.adapter.assertReceiveReady(proof, context), /replaced/u);
  assert.throws(() => f.adapter.bindReceiver({ ...chosen, receiverEpoch: 8 }, receipt(20), proof), /acknowledgement/u);
  await f.owner.stop();
});

test('a bounded per-output ledger rejects excess receivers and removes all bindings when that output retires', async () => {
  const f = fixture({ maximumReceivers: 1 });
  await f.owner.start('selected');
  for (const id of [20, 21]) {
    const chosen = selection(id), proof = await f.adapter.prepareReceive(f.context(chosen));
    if (id === 20) f.adapter.bindReceiver({ ...chosen, receiverEpoch: 8 }, receipt(id), proof);
    else assert.throws(() => f.adapter.bindReceiver({ ...chosen, receiverEpoch: 8 }, receipt(id), proof), /limit/u);
  }
  assert.equal(f.adapter.getStats().receivers, 1);
  await f.owner.stop();
  assert.equal(f.adapter.getStats().receivers, 0);
  assert.equal(f.calls.some(call => call.operation.startsWith('peer.')), false);
});

const sfuContext = (f, changes = {}) => ({
  engine: f.engine, callId: 'call', channelId: 'channel', remoteSessionId: 'remote',
  connectionId: 'connection', generation: 1, transportId: 10, serverTransportId: 'recv-transport',
  producerId: 'screen-audio-producer', serverConsumerId: 'consumer-a', reason: 'sfu-consumer',
  kind: 'audio', shareId: 'screen-one', screenAudioShareId: 'screen-one', syncGroup: 'source-group',
  watchVersion: 3, signal: f.abort.signal, ...changes,
});
const sfuReceipt = (consumerId = 40, serverConsumerId = 'consumer-a') => ({
  consumerId, serverConsumerId, kind: 'audio', syncGroup: 'source-group', mid: String(consumerId), trackId: serverConsumerId,
});

test('SFU requires the same genuine output owner and never starts an unselected or uncalibrated output', async () => {
  const f = fixture(), uncalibrated = fixture({ calibrated: false });
  assert.equal(isNativeAudioReceiveAdapterForEngine(f.adapter, f.engine, 'call', 'channel'), true);
  for (const adapter of [{}, Object.create(NativeAudioReceiveAdapter.prototype)]) {
    assert.equal(isNativeAudioReceiveAdapterForEngine(adapter, f.engine, 'call', 'channel'), false);
  }
  assert.equal(isNativeAudioReceiveAdapterForEngine(f.adapter, {}, 'call', 'channel'), false);
  assert.equal(isNativeAudioReceiveAdapterForEngine(f.adapter, f.engine, 'other', 'channel'), false);
  await assert.rejects(f.adapter.prepareSfuReceive(sfuContext(f)), /Select, start and calibrate/u);
  assert.deepEqual(f.calls, []);
  await uncalibrated.owner.start('selected-without-clock');
  await assert.rejects(uncalibrated.adapter.prepareSfuReceive(sfuContext(uncalibrated)), /calibrate/u);
  await uncalibrated.owner.stop();
});

test('SFU preparation captures an opaque exact epoch before paused creation and binds only its actual native media metadata', async () => {
  const f = fixture();
  await f.owner.start('selected');
  const context = sfuContext(f), proof = await f.adapter.prepareSfuReceive(context), receipt = sfuReceipt();
  assert.deepEqual(Object.keys(proof), []);
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(f.adapter.expectedSfuOutputEpoch(proof, context), 1);
  assert.equal(f.adapter.getStats().sfuPreparations, 1);
  assert.equal(f.adapter.getStats().sfuConsumers, 0);
  for (const change of [
    { consumerId: 0 }, { serverConsumerId: 'foreign' }, { syncGroup: 'other-group' }, { kind: 'video' },
    { mid: null }, { mid: '' }, { trackId: '' }, { trackId: 'manufactured-track' }, { streamIds: ['source-group'] },
  ]) assert.throws(() => f.adapter.bindSfuConsumer({ ...receipt, ...change }, proof, context), /actual paused consumer/u);
  assert.equal(f.adapter.bindSfuConsumer(receipt, proof, context), true);
  assert.throws(() => f.adapter.bindSfuConsumer(receipt, proof, context), /actual paused consumer/u);
  receipt.mid = 'mutated';
  assert.equal(f.adapter.getStats().sfuBindings[0].mid, '40');
  assert.equal(f.adapter.getStats().sfuBindings[0].enabled, false);
  await f.owner.stop();
});

test('SFU proof cannot cross protocols, engines, call/transport generations, producers, screens, consumers, Watches or signals', async () => {
  const f = fixture(), other = fixture();
  await f.owner.start('selected');
  const context = sfuContext(f), proof = await f.adapter.prepareSfuReceive(context);
  const p2pProof = await f.adapter.prepareReceive(f.context());
  assert.throws(() => f.adapter.expectedSfuOutputEpoch(p2pProof, context), /original live/u);
  assert.throws(() => f.adapter.expectedOutputEpoch(proof, f.context()), /original preparation/u);
  assert.throws(() => other.adapter.expectedSfuOutputEpoch(proof, sfuContext(other)), /original live/u);
  assert.throws(() => f.adapter.expectedSfuOutputEpoch({}, context), /original live/u);
  for (const change of [
    { engine: {} }, { callId: 'other' }, { channelId: 'other' }, { connectionId: 'other' }, { generation: 2 },
    { remoteSessionId: 'someone-else' }, { transportId: 11 }, { serverTransportId: 'other-transport' },
    { producerId: 'other-producer' }, { serverConsumerId: 'other-consumer' }, { watchVersion: 4 },
    { shareId: 'screen-two', screenAudioShareId: 'screen-two' }, { syncGroup: 'other-group' },
    { signal: new AbortController().signal },
  ]) assert.throws(() => f.adapter.assertSfuReceiveReady(proof, { ...context, ...change }));
  assert.equal(f.adapter.bindSfuConsumer(sfuReceipt(), proof, context), true);
  f.abort.abort();
  assert.throws(() => f.adapter.expectedSfuOutputEpoch(proof, context), { name: 'AbortError' });
  assert.equal(f.adapter.revokeSfuReceive(proof, context, 'watch-stopped'), true);
  assert.equal(f.adapter.getStats().sfuPreparations, 0);
  await f.owner.stop();
});

test('SFU volume and enable receipts are consumer-scoped, independent, immutable and cannot resurrect a revoked proof', async () => {
  const f = fixture();
  await f.owner.start('selected');
  const context = sfuContext(f), proof = await f.adapter.prepareSfuReceive(context);
  assert.throws(() => f.adapter.onSfuConsumerVolume(40, { consumerId: 40, volume: 0 }, proof, context), /exact bound/u);
  f.adapter.bindSfuConsumer(sfuReceipt(), proof, context);
  assert.throws(() => f.adapter.onSfuConsumerEnabled(41, { enabled: true }, proof, context), /exact bound/u);
  assert.throws(() => f.adapter.onSfuConsumerEnabled(40, { enabled: true, requestedEnabled: true }, proof, context), /malformed/u);
  for (const receipt of [{ consumerId: 41, volume: 1 }, { consumerId: 40, volume: NaN }, { consumerId: 40, volume: 2.1 }]) {
    assert.throws(() => f.adapter.onSfuConsumerVolume(40, receipt, proof, context), /acknowledgement/u);
  }
  f.adapter.onSfuConsumerVolume(40, { consumerId: 40, volume: 0 }, proof, context);
  assert.equal(f.adapter.getStats().sfuBindings[0].enabled, false);
  f.adapter.onSfuConsumerEnabled(40, { enabled: true }, proof, context);
  const state = f.adapter.getStats();
  assert.equal(state.sfuBindings[0].volume, 0);
  assert.equal(state.sfuBindings[0].enabled, true);
  assert.throws(() => { state.sfuBindings[0].outputEpoch = 9; }, TypeError);
  assert.equal(f.adapter.revokeSfuReceive(proof, { ...context, producerId: 'other' }, 'stale-stop'), false);
  assert.equal(f.adapter.getStats().sfuConsumers, 1);
  assert.equal(f.adapter.revokeSfuReceive(proof, context, 'watch-stopped'), true);
  assert.equal(f.adapter.revokeSfuReceive(proof, context, 'duplicate-stop'), false);
  assert.throws(() => f.adapter.onSfuConsumerEnabled(40, { enabled: true }, proof, context), /original live/u);
  assert.equal(f.owner.getStats().ready, true);
  await f.owner.stop();
});

test('an E2 output cannot satisfy an old E1 SFU creation, volume or activation preparation', async () => {
  const f = fixture();
  await f.owner.start('first');
  const context = sfuContext(f), proof = await f.adapter.prepareSfuReceive(context);
  f.adapter.bindSfuConsumer(sfuReceipt(), proof, context);
  await f.owner.stop();
  await f.owner.start('second');
  assert.throws(() => f.adapter.expectedSfuOutputEpoch(proof, context), /replaced/u);
  assert.throws(() => f.adapter.onSfuConsumerEnabled(40, { enabled: true }, proof, context), /replaced/u);
  assert.throws(() => f.adapter.onSfuConsumerVolume(40, { consumerId: 40, volume: 1 }, proof, context), /replaced/u);
  assert.equal(f.adapter.getStats().sfuConsumers, 0);
  const next = await f.adapter.prepareSfuReceive(context);
  assert.equal(f.adapter.expectedSfuOutputEpoch(next, context), 2);
  assert.throws(() => f.adapter.bindSfuConsumer(sfuReceipt(), proof, context), /original live/u);
  await f.owner.stop();
});

test('SFU preparations reserve bounded shared receiver capacity before native receiving effects', async () => {
  const f = fixture({ maximumReceivers: 1 });
  await f.owner.start('selected');
  const context = sfuContext(f), proof = await f.adapter.prepareSfuReceive(context);
  await assert.rejects(f.adapter.prepareSfuReceive(sfuContext(f, { serverConsumerId: 'second' })), /limit/u);
  const chosen = selection(), p2p = await f.adapter.prepareReceive(f.context(chosen));
  assert.throws(() => f.adapter.bindReceiver({ ...chosen, receiverEpoch: 8 }, receipt(20), p2p), /limit/u);
  f.adapter.revokeSfuReceive(proof, context, 'unadmitted-consumer');
  assert.equal(f.adapter.bindReceiver({ ...chosen, receiverEpoch: 8 }, receipt(20), p2p), true);
  await assert.rejects(f.adapter.prepareSfuReceive(context), /limit/u);
  f.adapter.revokeReceiver({ ...chosen, receiverEpoch: 8 }, 'p2p-stopped');
  const fresh = await f.adapter.prepareSfuReceive(context);
  f.setCurrent(false);
  assert.throws(() => f.adapter.bindSfuConsumer(sfuReceipt(), fresh, context), /current call/u);
  assert.equal(f.adapter.getStats().sfuPreparations, 0);
  f.setCurrent(true);
  assert.throws(() => f.adapter.bindSfuConsumer(sfuReceipt(), fresh, context), /original live/u);
  await f.owner.stop();
});
