'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NativeAudioOutputOwner } = require('../runtime/nativeAudioOutputOwner.cjs');
const { NativeRtcCommands } = require('../runtime/nativeRtcCommands.cjs');
const { NativeAudioClockClient } = require('../runtime/nativeAudioClockClient.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const containsError = (error, pattern) => pattern.test(error.message)
  || (error instanceof AggregateError && error.errors.some(child => containsError(child, pattern)));
const rejectsWith = (promise, pattern) => assert.rejects(promise, error => containsError(error, pattern));
const pcm = (epoch = 1, sequence = 0, changes = {}) => ({
  epoch, sequence, firstPlayoutFrame: sequence * 480, frames: 480, sampleRate: 48000, channels: 2,
  samples: new Float32Array(960).fill(0.125), ...changes,
});
const outputError = (epoch = 1) => ({
  type: 'audio.outputError', target: 0,
  data: { epoch, code: 'ERR_RTC_AUDIO_OUTPUT',
    message: 'Audio output epoch failed; select/recreate a new output epoch',
    status: 7, hresult: 0, terminal: false },
});
const invalidated = (epoch = 1, reason = 'transport-detached') => ({
  type: 'audio.outputInvalidated', target: 0, data: { epoch, reason },
});

function fixture(hooks = {}, timeoutMs = 150) {
  const calls = [], errors = [], packets = [], outputs = new Map();
  let owner, commands, nextCalibration = 1;
  const view = () => ({ owner, commands, calls, errors, packets, outputs });
  const engine = {
    request(id, operation, target, data) {
      assert.deepEqual(commands.getPendingRequest(id), { id, operation, target, data });
      calls.push({ type: operation, id, target, data });
      assert.equal(target, 0);
      if (operation === 'audio.configureOutput') {
        assert.equal(outputs.get(data.epoch)?.selected, true, 'Configure follows actual renderer selection in the double');
        return hooks.configure ? hooks.configure(data, view())
          : Promise.resolve({ epoch: data.epoch, sampleRate: 48000, channels: 2 });
      }
      if (operation === 'audio.stopOutput') return hooks.nativeStop ? hooks.nativeStop(data, view()) : Promise.resolve({});
      throw new Error(`Unexpected native command: ${operation}`);
    },
    grantAudioCredits(data) {
      calls.push({ type: 'grant', data });
      return hooks.grant?.(data, view());
    },
    audioClockProbe(data) {
      calls.push({ type: 'probe', data });
      return hooks.probe ? hooks.probe(data, view())
        : { ...data, rtcBeforeUs: 2000000, rtcAfterUs: 2000100 };
    },
    calibrateAudioClock(data) {
      calls.push({ type: 'calibrate', data });
      return hooks.calibrate ? hooks.calibrate(data, view())
        : { epoch: data.epoch, calibrationId: nextCalibration++, offsetUs: -1000.5, uncertaintyUs: 16300 };
    },
    setAudioOutputFeedback(data) {
      calls.push({ type: 'feedback', data });
      return hooks.feedback?.(data, view());
    },
    close() {
      calls.push({ type: 'engine.close' });
      return hooks.close ? hooks.close(view()) : Promise.resolve({ closed: true });
    },
  };
  commands = new NativeRtcCommands(engine);
  const renderer = {
    start(config, signal) {
      calls.push({ type: 'renderer.start', config, signal });
      const output = { config, signal, selected: false, ready: false, closed: false };
      outputs.set(config.epoch, output);
      if (hooks.start) return hooks.start(config, signal, view());
      return (async () => {
        await hooks.select?.(config, view());
        if (signal.aborted) throw signal.reason;
        output.selected = true;
        calls.push({ type: 'renderer.selected', config });
        await hooks.beforePrepare?.(config, view());
        if (signal.aborted) throw signal.reason;
        if (!hooks.skipPrepare) await owner.configureOutput(config);
        await hooks.afterPrepare?.(config, view());
        if (signal.aborted) throw signal.reason;
        output.ready = true;
        calls.push({ type: 'renderer.ready', config });
        return hooks.ready ? hooks.ready(config, view()) : { ...config };
      })();
    },
    stop(epoch) {
      calls.push({ type: 'renderer.stop', epoch });
      if (hooks.rendererStop) return hooks.rendererStop(epoch, view());
      return Promise.resolve().then(() => {
        const output = outputs.get(epoch);
        if (output) { output.closed = true; output.ready = false; }
      });
    },
    enqueue(packet) {
      calls.push({ type: 'renderer.enqueue', packet });
      packets.push(packet);
      return hooks.enqueue ? hooks.enqueue(packet, view()) : Promise.resolve();
    },
  };
  owner = new NativeAudioOutputOwner(engine, commands, renderer, (error, context) => {
    errors.push({ error, context });
    return hooks.onError?.(error, context);
  }, { timeoutMs });
  return {
    engine, commands, renderer, owner, hooks, calls, errors, packets, outputs,
    emit: packet => owner.handleNativeEvent({ type: 'audio.playout', target: 0, data: packet }),
    count: type => calls.filter(call => call.type === type).length,
  };
}

test('isolated native audio waits for correlated credits and preserves real clock replies across IPC', async () => {
  const admission = deferred();
  const f = fixture({ grant: () => admission.promise });
  f.engine.asynchronousNative = true;
  for (const name of ['audioClockProbe', 'calibrateAudioClock', 'setAudioOutputFeedback']) {
    const direct = f.engine[name];
    f.engine[name] = (...args) => Promise.resolve().then(() => direct(...args));
  }
  await f.owner.start('owned-output');
  const granting = f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 });
  assert.equal(f.owner.getStats().acceptedGrants, 0);
  admission.resolve();
  assert.equal(await granting, true);
  const observed = await f.owner.probe({ epoch: 1, probeId: 1 });
  assert.deepEqual(observed, { epoch: 1, probeId: 1, rtcBeforeUs: 2000000, rtcAfterUs: 2000100 });
  const calibrated = await f.owner.calibrate({
    epoch: 1, probeId: 1, rendererBeforeUs: 1999000, rendererAfterUs: 1999200,
  });
  assert.equal(calibrated.calibrationId, 1);
  assert.equal(await f.owner.feedback({ epoch: 1, available: false }), true);
  await f.owner.stop();
  assert.deepEqual(f.errors, []);
});

test('isolated credit rejection never becomes admission or native output retirement', async () => {
  const admission = deferred();
  const f = fixture({ grant: () => admission.promise });
  f.engine.asynchronousNative = true;
  await f.owner.start('owned-output');
  const granting = f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 });
  const rejected = assert.rejects(granting, /host exited/u);
  admission.reject(new Error('host exited'));
  await rejected;
  assert.equal(f.owner.getStats().acceptedGrants, 0);
  await f.owner.finishAfterEngineClose(f.commands.closeEngine());
  assert.equal(f.owner.getStats().stopped, true);
});

test('a real IPC credit acknowledgement arriving after stop cannot revive or fail the retired output', async () => {
  const admission = deferred(), f = fixture({ grant: () => admission.promise });
  f.engine.asynchronousNative = true;
  await f.owner.start('owned-output');
  const granting = f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 });
  await f.owner.stop();
  admission.resolve();
  assert.equal(await granting, false);
  assert.equal(f.owner.getStats().stopped, true);
  assert.deepEqual(f.errors, []);
});

test('constructor and import are inert; one real same-engine owner persists across all restarts', async () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  assert.equal(f.owner.getStats().state, 'idle');
  assert.equal(f.owner.getStats().epoch, null);
  assert.equal(f.owner.getStats().stopped, true);
  assert.equal(Object.keys(require.cache).some(filename => filename.endsWith('.node')), false);
  assert.throws(() => new NativeAudioOutputOwner(f.engine, f.commands, f.renderer, () => {}), /One global/u);
  assert.throws(() => new NativeAudioOutputOwner(f.engine, {
    engine: f.engine, request: f.commands.request.bind(f.commands), assertEngineClosed() {},
  }, f.renderer, () => {}), /same-engine/u);
  const other = fixture();
  assert.throws(() => new NativeAudioOutputOwner(f.engine, other.commands, f.renderer, () => {}), /same-engine/u);
  Object.defineProperty(other.commands, 'engine', { value: f.engine });
  assert.throws(() => new NativeAudioOutputOwner(f.engine, other.commands, f.renderer, () => {}), /same-engine/u);
  await f.owner.start('chosen-speakers');
  await f.owner.stop();
  assert.throws(() => new NativeAudioOutputOwner(f.engine, f.commands, f.renderer, () => {}), /must persist/u);
  assert.equal(f.count('engine.close'), 0);
});

test('explicit output selection and prepareOutput precede native configure and actual readiness', async () => {
  const selection = deferred(), configured = deferred(), readiness = deferred();
  const f = fixture({
    select: () => selection.promise, configure: () => configured.promise, afterPrepare: () => readiness.promise,
  });
  const starting = f.owner.start('opaque-selected-output');
  let ready = false;
  void starting.then(() => { ready = true; });
  await tick();
  assert.equal(f.count('audio.configureOutput'), 0);
  assert.equal(f.count('grant'), 0);
  selection.resolve();
  await tick();
  assert.equal(f.count('audio.configureOutput'), 1);
  const duplicatePreparation = f.owner.configureOutput(f.outputs.get(1).config);
  assert.deepEqual(f.calls.find(call => call.type === 'audio.configureOutput').data, { epoch: 1 });
  assert.equal(ready, false);
  configured.resolve({ epoch: 1, sampleRate: 48000, channels: 2 });
  assert.deepEqual(await duplicatePreparation, { epoch: 1, sampleRate: 48000, channels: 2 });
  await tick();
  assert.equal(f.owner.getStats().nativeConfigured, true);
  assert.equal(f.owner.getStats().ready, false);
  readiness.resolve();
  assert.deepEqual(await starting, { epoch: 1, sinkId: 'opaque-selected-output', sampleRate: 48000, channels: 2 });
  assert.equal(ready, true);
  assert.deepEqual(await f.owner.configureOutput(f.outputs.get(1).config), { epoch: 1, sampleRate: 48000, channels: 2 });
  assert.equal(f.count('audio.configureOutput'), 1);
  await f.owner.stop();
});

test('credits before prepareOutput completes fail instead of starting an implicit/default output', async () => {
  const preparing = deferred(), f = fixture({ beforePrepare: () => preparing.promise });
  const starting = f.owner.start('exact-output');
  const rejected = rejectsWith(starting, /prepareOutput/u);
  await tick();
  assert.throws(() => f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 960 }), /prepareOutput/u);
  preparing.resolve();
  await rejected;
  assert.equal(f.count('audio.configureOutput'), 0);
  assert.equal(f.count('grant'), 0);
  assert.equal(f.owner.getStats().stopped, true);
});

test('first credit reserves accounting before reentrant native PCM, even before start returns ready', async () => {
  const f = fixture({
    afterPrepare(config, { owner }) {
      assert.equal(owner.getStats().ready, false);
      owner.grantCredits({ epoch: config.epoch, grantSequence: 1, frames: 960 });
    },
    grant(data, { owner }) {
      assert.equal(owner.getStats().nativeConfigured, true);
      assert.equal(owner.getStats().lastGrantSequence, 1);
      assert.equal(owner.getStats().outstandingCreditFrames, 960);
      for (let sequence = 0; sequence < 2; sequence++) {
        assert.equal(owner.handleNativeEvent({ type: 'audio.playout', target: 0, data: pcm(data.epoch, sequence) }), true);
      }
    },
  });
  await f.owner.start('headphones');
  assert.equal(f.packets.length, 2);
  assert.equal(f.packets[0].samples[0], 0.125);
  assert.equal(f.owner.getStats().nextPlayoutFrame, 960);
  assert.equal(f.owner.getStats().outstandingCreditFrames, 0);
  assert.deepEqual(f.errors, []);
  const ordering = f.calls.map(call => call.type);
  assert.ok(ordering.indexOf('audio.configureOutput') < ordering.indexOf('grant'));
  assert.ok(ordering.indexOf('renderer.enqueue') < ordering.indexOf('renderer.ready'));
  await f.owner.stop();
});

test('reentrant renderer admission reserves each enqueue before further credits or packets', async () => {
  const queued = deferred();
  let nextSequence = 0;
  const f = fixture({
    grant(data, { owner }) {
      for (let index = 0; index < data.frames / 480; index++) {
        const packet = pcm(data.epoch, nextSequence++);
        owner.handleNativeEvent({ type: 'audio.playout', target: 0, data: packet });
      }
    },
    enqueue(packet, { owner }) {
      if (packet.sequence === 0) {
        assert.equal(owner.getStats().pendingEnqueues, 1);
        assert.equal(owner.getStats().nextSequence, 1);
        owner.grantCredits({ epoch: packet.epoch, grantSequence: 2, frames: 960 });
      }
      return queued.promise;
    },
  });
  await f.owner.start('headphones');
  assert.equal(f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 960 }), true);
  assert.deepEqual(f.packets.map(packet => packet.sequence), [0, 1, 2, 3]);
  assert.equal(f.owner.getStats().pendingEnqueues, 4);
  assert.equal(f.owner.getStats().reservedFrames, 1920);
  assert.equal(f.owner.getStats().outstandingCreditFrames, 0);
  queued.resolve();
  await tick();
  assert.equal(f.owner.getStats().pendingEnqueues, 0);
  await f.owner.stop();
});

test('native grant failure after synchronous PCM preserves ambiguous accounting and fails visibly', async () => {
  const failure = new Error('Double admission threw after emitting PCM');
  const f = fixture({
    grant(data, { owner }) {
      owner.handleNativeEvent({ type: 'audio.playout', target: 0, data: pcm(data.epoch) });
      throw failure;
    },
  });
  await f.owner.start('selected-output');
  assert.throws(() => f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 960 }), failure);
  const stats = f.owner.getStats();
  assert.equal(stats.grantAdmissionUncertain, true);
  assert.equal(stats.lastGrantSequence, 1);
  assert.equal(stats.outstandingCreditFrames, 480);
  assert.equal(stats.nextSequence, 1);
  assert.equal(stats.acceptedGrants, 0);
  assert.ok(f.errors.some(entry => entry.error === failure && entry.context.phase === 'grantCredits' && entry.context.epoch === 1));
  await f.owner.stop();
  assert.equal(f.owner.getStats().nativeRetired, true);
  assert.equal(f.owner.getStats().outstandingCreditFrames, 0);
});

test('a persistent owner allocates increasing epochs, preserves exact devices and resets clocks/cursors', async () => {
  const f = fixture();
  for (const [epoch, sinkId] of [[1, 'headphones'], [2, 'speakers']]) {
    const ready = await f.owner.start(sinkId);
    assert.equal(ready.epoch, epoch);
    await assert.rejects(f.owner.start('another-output'), /still owns/u);
    assert.equal(f.owner.getStats().nextSequence, 0);
    assert.equal(f.owner.getStats().calibrationId, null);
    f.owner.grantCredits({ epoch, grantSequence: 1, frames: 480 });
    f.emit(pcm(epoch));
    f.owner.probe({ epoch, probeId: 1 });
    const calibration = f.owner.calibrate({ epoch, probeId: 1, rendererBeforeUs: 1000000, rendererAfterUs: 1000500 });
    assert.equal(calibration.calibrationId, epoch);
    assert.equal((await f.owner.stop(epoch)).stopped, true);
  }
  assert.deepEqual(f.calls.filter(call => call.type === 'audio.configureOutput').map(call => call.data.epoch), [1, 2]);
  assert.deepEqual(f.calls.filter(call => call.type === 'audio.stopOutput').map(call => call.data.epoch), [1, 2]);
  assert.deepEqual(f.calls.filter(call => call.id).map(call => call.id), [1, 2, 3, 4]);
  assert.equal(f.owner.getStats().retiredThrough, 2);
  assert.equal(f.count('engine.close'), 0);
});

test('cancellation aborts and retires the renderer before a late native configure is stopped for its own epoch', async () => {
  const native = deferred(), controller = new AbortController();
  const f = fixture({ configure: () => native.promise }, 20);
  const starting = f.owner.start('first-device', controller.signal);
  const rejected = rejectsWith(starting, /stopped|configuration has not drained/u);
  await tick();
  assert.equal(f.count('audio.configureOutput'), 1);
  controller.abort();
  assert.equal(f.outputs.get(1).signal.aborted, true);
  await rejected;
  assert.ok(f.count('renderer.stop') >= 1);
  assert.equal(f.outputs.get(1).closed, true);
  assert.equal(f.count('audio.stopOutput'), 0);
  assert.equal(f.owner.getStats().nativeRetired, false);
  await assert.rejects(f.owner.start('replacement'), /still owns/u);
  native.resolve({ epoch: 1, sampleRate: 48000, channels: 2 });
  await tick();
  assert.equal(f.count('audio.stopOutput'), 1);
  assert.equal(f.owner.getStats().stopped, true);
  f.hooks.configure = undefined;
  assert.equal((await f.owner.start('replacement')).epoch, 2);
  assert.equal(await f.owner.stop(1), false);
  assert.equal(f.owner.getStats().ready, true);
  assert.deepEqual(f.calls.filter(call => call.type === 'audio.stopOutput').map(call => call.data.epoch), [1]);
  await f.owner.stop(2);
});

test('late configure failure is visible and still needs a real scoped stop, not a cancellation/status shortcut', async () => {
  const native = deferred(), f = fixture({ configure: () => native.promise }, 20);
  const starting = f.owner.start('selected-output');
  const rejected = rejectsWith(starting, /stopped|drained/u);
  await tick();
  await rejectsWith(f.owner.stop(), /configuration has not drained/u);
  await rejected;
  const failure = Object.assign(new Error('Double configure completion failed'), { code: 'ERR_RTC_ENGINE_CLOSED' });
  native.reject(failure);
  await tick();
  assert.ok(f.errors.some(entry => entry.error === failure && entry.context.phase === 'native.configure'));
  assert.equal(f.count('audio.stopOutput'), 1);
  assert.equal(f.owner.getStats().engineClosed, false);
  assert.equal(f.owner.getStats().stopped, true);
});

test('stop during selection aborts immediately and a late renderer completion receives a final stop', async () => {
  const selection = deferred(), f = fixture({ select: () => selection.promise }, 20);
  const starting = f.owner.start('selected-output');
  const rejected = rejectsWith(starting, /stopped|startup has not drained/u);
  await tick();
  const stopping = f.owner.stop();
  assert.equal(f.outputs.get(1).signal.aborted, true);
  await rejectsWith(stopping, /startup has not drained/u);
  await rejected;
  assert.equal(f.count('renderer.stop'), 1);
  assert.equal(f.count('audio.configureOutput'), 0);
  await assert.rejects(f.owner.start('next-device'), /still owns/u);
  selection.resolve();
  await tick();
  assert.equal(f.count('renderer.stop'), 2);
  assert.equal(f.owner.getStats().stopped, true);
  assert.equal(f.count('audio.configureOutput'), 0);
});

test('stop before renderer dispatch consumes the allocated epoch without starting either side', async () => {
  const f = fixture();
  const starting = f.owner.start('selected-output');
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  await f.owner.stop();
  await rejected;
  assert.deepEqual(f.calls, []);
  assert.equal(f.owner.getStats().retiredThrough, 1);
  assert.equal((await f.owner.start('replacement')).epoch, 2);
  await f.owner.stop();
});

test('renderer start failure always retires actual renderer resources and any configured native output', async t => {
  for (const phase of ['beforePrepare', 'afterPrepare']) {
    await t.test(phase, async () => {
      const failure = new Error(`Double renderer ${phase} failure`);
      const f = fixture({ [phase]: () => { throw failure; } });
      await assert.rejects(f.owner.start('no-fallback'), failure);
      assert.equal(f.owner.getStats().stopped, true);
      assert.ok(f.count('renderer.stop') >= 1);
      assert.equal(f.count('audio.configureOutput'), phase === 'afterPrepare' ? 1 : 0);
      assert.equal(f.count('audio.stopOutput'), phase === 'afterPrepare' ? 1 : 0);
      assert.deepEqual(f.calls.filter(call => call.type === 'renderer.start').map(call => call.config.sinkId), ['no-fallback']);
      assert.equal(f.count('grant'), 0);
    });
  }
});

test('readiness has no defaults, implicit configure or synchronous acknowledgements', async t => {
  for (const [name, hooks, pattern] of [
    ['missing prepare handshake', { skipPrepare: true }, /prepareOutput handshake/u],
    ['synchronous renderer start', { start: config => ({ ...config }) }, /readiness Promise/u],
    ['missing renderer metadata', { ready: () => ({ ready: true }) }, /invalid audio readiness/u],
    ['wrong selected renderer output', { ready: config => ({ ...config, sinkId: 'wrong-device' }) }, /exact selected output/u],
    ['wrong native sample rate', { configure: data => Promise.resolve({ epoch: data.epoch, sampleRate: 44100, channels: 2 }) }, /configuration does not match/u],
  ]) {
    await t.test(name, async () => {
      const f = fixture(hooks);
      await rejectsWith(f.owner.start('explicit-device'), pattern);
      assert.equal(f.owner.getStats().ready, false);
      assert.equal(f.owner.getStats().stopped, true);
      assert.equal(f.count('grant'), 0);
    });
  }
});

test('a malformed native configure identity cannot be retired by guessing another epoch', async () => {
  const f = fixture({ configure: () => Promise.resolve({ epoch: 99, sampleRate: 48000, channels: 2 }) });
  await rejectsWith(f.owner.start('chosen-output'), /configuration does not match/u);
  assert.equal(f.owner.getStats().nativeRetired, false);
  assert.deepEqual(f.calls.filter(call => call.type === 'audio.stopOutput').map(call => call.data.epoch), [1]);
  await assert.rejects(f.owner.start('replacement'), /still owns/u);
  await f.owner.finishAfterEngineClose(f.commands.closeEngine());
  assert.equal(f.owner.getStats().stopped, true);
});

test('two peers share one global mixer without inferring ADM invalidation from their lifecycle events', async () => {
  const f = fixture(), peers = new Map([[11, { audio: true, video: true }], [22, { audio: true, video: true }]]);
  await f.owner.start('global-speakers');
  for (const peerId of peers.keys()) {
    assert.equal(f.owner.handleNativeEvent({ type: 'peer.trackAdded', target: peerId, data: { kind: 'audio' } }), false);
  }
  for (const [peerId, peer] of peers) {
    peer.audio = false;
    assert.equal(f.owner.handleNativeEvent({ type: 'peer.trackRemoved', target: peerId, data: { kind: 'audio' } }), false);
  }
  assert.equal(peers.size, 2);
  assert.equal([...peers.values()].every(peer => peer.video), true);
  assert.equal(f.count('audio.configureOutput'), 1);
  assert.equal(f.count('audio.stopOutput'), 0);
  assert.equal(f.count('renderer.stop'), 0);
  assert.equal(f.owner.getStats().outputErrors, 0);
  assert.deepEqual(f.errors, []);
  await f.owner.stop();
});

test('the native global audio failure event invalidates its epoch independently of peer lifecycle', async () => {
  const f = fixture();
  await f.owner.start('global-speakers');
  const event = outputError();
  assert.equal(f.owner.handleNativeEvent(event), true);
  assert.equal(f.owner.getStats().ready, false);
  const reported = f.errors.find(entry => entry.context.phase === 'audio.outputError');
  for (const key of ['code', 'message', 'status', 'hresult', 'terminal']) assert.equal(reported.error[key], event.data[key]);
  await f.owner.stop();
  await assert.rejects(f.owner.configureOutput(f.outputs.get(1).config), /retired epoch/u);
  assert.equal(f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 }), false);
  assert.equal((await f.owner.start('global-speakers')).epoch, 2);
  assert.equal(f.owner.getStats().calibrationId, null);
  assert.equal(f.owner.handleNativeEvent(outputError(1)), true);
  assert.equal(f.owner.getStats().staleOutputErrors, 1);
  assert.equal(f.owner.getStats().ready, true);
  await f.owner.stop();
});

test('each genuine output retirement withdraws readiness before the error observer without closing the engine', async t => {
  for (const reason of ['owner-stop', 'engine-close', 'transport-detached', 'setup-failed', 'mixer-failure']) {
    await t.test(reason, async () => {
      let f;
      f = fixture({ onError(_error, context) {
        if (context.phase === 'audio.outputInvalidated') assert.equal(f.owner.getStats().ready, false);
      } });
      await f.owner.start('selected');
      assert.equal(f.owner.handleNativeEvent(invalidated(1, reason)), true);
      assert.equal(f.owner.getStats().ready, false);
      assert.equal(f.owner.getStats().nativeConfigured, false);
      assert.equal(f.owner.getStats().outputInvalidationReason, reason);
      assert.equal(f.owner.getStats().nativeRetired, false);
      assert.equal(f.owner.getStats().engineClosed, false);
      assert.equal(f.owner.getStats().outputInvalidations, 1);
      assert.equal(f.errors[0].error.reason, reason);
      assert.equal(f.errors[0].error.code, 'ERR_NATIVE_AUDIO_OUTPUT_INVALIDATED');
      assert.equal(f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 }), false);
      await f.owner.stop();
      assert.equal(f.owner.getStats().stopped, true);
      assert.equal(f.count('engine.close'), 0);
    });
  }
});

test('normal RTC pause preserves the selected output, credit sequence and mixer ownership', async () => {
  const f = fixture();
  await f.owner.start('selected');
  f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 960 });
  assert.equal(f.owner.handleNativeEvent({ type: 'peer.trackRemoved', target: 10, data: { kind: 'audio' } }), false);
  assert.equal(f.owner.getStats().ready, true);
  assert.equal(f.owner.getStats().nativeConfigured, true);
  assert.equal(f.owner.getStats().outstandingCreditFrames, 960);
  assert.equal(f.owner.getStats().outputInvalidations, 0);
  assert.equal(f.count('audio.stopOutput'), 0);
  f.owner.grantCredits({ epoch: 1, grantSequence: 2, frames: 480 });
  assert.equal(f.owner.getStats().lastGrantSequence, 2);
  assert.equal(f.owner.getStats().outstandingCreditFrames, 1440);
  assert.deepEqual(f.errors, []);
  await f.owner.stop();
});

test('own stop receives its retirement event before the native ACK without recursion or a synthetic failure', async () => {
  const f = fixture({ nativeStop(data, { owner }) {
    assert.equal(owner.handleNativeEvent(invalidated(data.epoch, 'owner-stop')), true);
    assert.equal(owner.getStats().ready, false);
    assert.equal(owner.getStats().nativeRetired, false);
    return Promise.resolve({});
  } });
  await f.owner.start('selected');
  await f.owner.stop();
  assert.equal(f.owner.getStats().stopped, true);
  assert.equal(f.count('audio.stopOutput'), 1);
  assert.equal(f.owner.getStats().outputInvalidations, 1);
  assert.deepEqual(f.errors, []);
});

test('duplicate retirement cannot add cleanup while pending or touch a replacement after the original closes', async () => {
  const closed = deferred(), f = fixture({ rendererStop: () => closed.promise });
  await f.owner.start('first');
  f.owner.handleNativeEvent(invalidated());
  const stopping = f.owner.stop(1);
  for (let index = 0; index < 4; index++) f.owner.handleNativeEvent(invalidated());
  await tick();
  assert.equal(f.count('renderer.stop'), 1);
  assert.equal(f.count('audio.stopOutput'), 1);
  assert.equal(f.owner.getStats().outputInvalidations, 1);
  assert.equal(f.owner.getStats().rendererRetired, false);
  await assert.rejects(f.owner.start('second'), /still owns/u);
  closed.resolve();
  await stopping;
  f.hooks.rendererStop = undefined;
  await f.owner.start('second');
  f.owner.handleNativeEvent(invalidated(1));
  f.owner.handleNativeEvent(invalidated(1, 'owner-stop'));
  f.owner.handleNativeEvent(outputError(1));
  await tick();
  assert.equal(f.owner.getStats().activeEpoch, 2);
  assert.equal(f.owner.getStats().ready, true);
  assert.equal(f.count('audio.stopOutput'), 1);
  assert.equal(f.owner.getStats().staleOutputInvalidations, 2);
  assert.ok(f.errors.some(entry => entry.context.phase === 'audio.outputError' && entry.context.epoch === 1));
  await f.owner.stop();
});

test('invalid or unallocated retirement messages report errors without stopping the owned output', async () => {
  const f = fixture();
  await f.owner.start('selected');
  let getterCalls = 0;
  const getter = { epoch: 1, get reason() { getterCalls++; return 'owner-stop'; } };
  for (const event of [
    invalidated(0), invalidated(2), invalidated(1, 'rtc-stop'), invalidated(1, 'unknown'),
    { ...invalidated(), target: 9 }, { ...invalidated(), extra: true },
    { ...invalidated(), data: { epoch: 1, reason: 'owner-stop', extra: true } },
    { ...invalidated(), data: getter },
  ]) {
    const before = f.errors.length;
    assert.equal(f.owner.handleNativeEvent(event), true);
    assert.equal(f.errors.length, before + 1);
    assert.equal(f.owner.getStats().ready, true);
    assert.equal(f.owner.getStats().outputInvalidations, 0);
  }
  assert.equal(getterCalls, 0);
  assert.equal(f.count('renderer.stop'), 0);
  assert.equal(f.count('audio.stopOutput'), 0);
  await f.owner.stop();
});

test('retirement during raw native configuration retains the pending operation and cannot restore readiness', async () => {
  const configure = deferred(), f = fixture({ configure: () => configure.promise });
  const starting = f.owner.start('selected');
  const rejected = assert.rejects(starting);
  await tick();
  f.owner.handleNativeEvent(invalidated(1, 'setup-failed'));
  assert.equal(f.owner.getStats().ready, false);
  assert.equal(f.owner.getStats().nativeRetired, false);
  assert.equal(f.owner.getStats().nativeConfigurationPending, true);
  await assert.rejects(f.owner.start('replacement'), /still owns/u);
  configure.resolve({ epoch: 1, sampleRate: 48000, channels: 2 });
  await rejected;
  await f.owner.stop();
  assert.equal(f.count('audio.stopOutput'), 1);
  assert.equal(f.owner.getStats().nativeConfigured, false);
  assert.equal(f.owner.getStats().stopped, true);
});

test('retirement during renderer selection retains its late startup without ever configuring native output', async () => {
  const selected = deferred(), f = fixture({ select: () => selected.promise });
  const starting = f.owner.start('selected');
  const rejected = assert.rejects(starting);
  await tick();
  f.owner.handleNativeEvent(invalidated(1, 'setup-failed'));
  assert.equal(f.owner.getStats().rendererStartupPending, true);
  assert.equal(f.owner.getStats().stopped, false);
  await assert.rejects(f.owner.start('replacement'), /still owns/u);
  selected.resolve();
  await rejected;
  await f.owner.stop();
  assert.equal(f.count('audio.configureOutput'), 0);
  assert.equal(f.owner.getStats().stopped, true);
});

test('failed renderer retirement after invalidation remains a bounded explicit cleanup obligation', async () => {
  const f = fixture({ rendererStop: () => Promise.reject(new Error('Context is still owned.')) });
  await f.owner.start('selected');
  f.owner.handleNativeEvent(invalidated(1, 'mixer-failure'));
  await rejectsWith(f.owner.stop(), /Context is still owned/u);
  const attempts = f.count('renderer.stop');
  f.owner.handleNativeEvent(invalidated(1, 'mixer-failure'));
  await tick();
  await tick();
  assert.equal(f.count('renderer.stop'), attempts);
  assert.equal(f.owner.getStats().rendererRetired, false);
  assert.equal(f.owner.getStats().stopped, false);
  assert.equal(f.owner.getStats().engineClosed, false);
  await assert.rejects(f.owner.start('replacement'), /still owns/u);
  f.hooks.rendererStop = undefined;
  await f.owner.stop();
  assert.equal(f.owner.getStats().stopped, true);
});

test('engine-close invalidation does not replace the independently awaited real engine close proof', async () => {
  const closed = deferred(), f = fixture({ close: () => closed.promise });
  await f.owner.start('selected');
  const finishing = f.owner.finishAfterEngineClose(f.commands.closeEngine());
  f.owner.handleNativeEvent(invalidated(1, 'engine-close'));
  await tick();
  assert.equal(f.owner.getStats().ready, false);
  assert.equal(f.owner.getStats().engineClosed, false);
  assert.equal(f.owner.getStats().nativeRetired, false);
  assert.equal(f.count('audio.stopOutput'), 0);
  closed.resolve({ closed: true });
  await finishing;
  assert.equal(f.owner.getStats().engineClosed, true);
  assert.equal(f.owner.getStats().stopped, true);
  assert.deepEqual(f.errors, []);
});

test('a retirement racing event delivery cannot turn last-observed readiness into an admission lease', async () => {
  let admEpoch = 0;
  const stale = Object.assign(new Error('Modeled native admission rejects the stopped output epoch'),
    { code: 'ERR_RTC_AUDIO_OUTPUT_EPOCH', status: 2 });
  const f = fixture({
    configure(data) {
      admEpoch = data.epoch;
      return Promise.resolve({ epoch: data.epoch, sampleRate: 48000, channels: 2 });
    },
    grant(data) {
      if (data.epoch !== admEpoch) throw stale;
    },
    nativeStop(data) {
      assert.equal(data.epoch, 1);
      assert.equal(admEpoch, 0, 'stopOutput(oldEpoch) is accepted when the ADM epoch is already zero');
      return Promise.resolve({});
    },
  });
  await f.owner.start('selected-output');
  const observed = f.owner.getStats(), callsBeforeNormalStop = f.calls.length;
  // Model a native retirement whose correlated event has not reached JavaScript yet.
  admEpoch = 0;
  await tick();
  assert.equal(admEpoch, 0);
  assert.equal(f.calls.length, callsBeforeNormalStop);
  assert.equal(f.owner.getStats().activeEpoch, observed.activeEpoch);
  assert.equal(f.owner.getStats().ready, observed.ready, 'An unchanged observed flag cannot prove current native readiness');
  assert.equal(f.owner.getStats().outputErrors, 0);
  assert.deepEqual(f.errors, []);
  assert.throws(() => f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 }), stale);
  assert.equal(f.owner.getStats().ready, false);
  assert.equal(f.owner.getStats().nativeRetired, false, 'A stale rejection is not CPU-output retirement proof');
  assert.equal(f.owner.getStats().outputErrors, 0, 'The direct rejection did not fabricate an outputError event');
  await f.owner.stop();
  assert.equal(f.owner.getStats().stopped, true);
});

test('already retired packets and controls cannot reach, stop or recalibrate a replacement output', async () => {
  const f = fixture();
  await f.owner.start('first');
  await f.owner.stop();
  await f.owner.start('replacement');
  const baseline = f.calls.length;
  assert.equal(f.emit(pcm(1)), true);
  assert.equal(f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 }), false);
  assert.equal(f.owner.feedback({ epoch: 1, available: false }), false);
  assert.throws(() => f.owner.probe({ epoch: 1, probeId: 1 }), /retired epoch/u);
  assert.throws(() => f.owner.calibrate({ epoch: 1, probeId: 1, rendererBeforeUs: 1, rendererAfterUs: 2 }), /retired epoch/u);
  await assert.rejects(f.owner.configureOutput(f.outputs.get(1).config), /retired epoch/u);
  assert.equal(await f.owner.stop(1), false);
  assert.equal(f.calls.length, baseline);
  assert.equal(f.packets.length, 0);
  assert.equal(f.owner.getStats().stalePackets, 1);
  assert.equal(f.owner.getStats().staleControls, 5);
  assert.equal(f.owner.getStats().ready, true);
  await f.owner.stop();
});

test('unallocated and invalid control epochs fail visibly without targeting an existing replacement', async () => {
  const f = fixture();
  await f.owner.start('selected');
  const baseline = f.calls.length;
  for (const epoch of [0, -1, NaN, Number.MAX_SAFE_INTEGER + 1, 2]) {
    assert.throws(() => f.owner.grantCredits({ epoch, grantSequence: 1, frames: 480 }), /epoch/u);
    assert.throws(() => f.owner.probe({ epoch, probeId: 1 }), /epoch/u);
    assert.throws(() => f.owner.calibrate({ epoch, probeId: 1, rendererBeforeUs: 1, rendererAfterUs: 2 }), /epoch/u);
    assert.throws(() => f.owner.feedback({ epoch, available: false }), /epoch/u);
    await assert.rejects(f.owner.configureOutput({ epoch, sinkId: 'selected', sampleRate: 48000, channels: 2 }), /epoch/u);
    await assert.rejects(f.owner.stop(epoch), /epoch/u);
  }
  assert.equal(f.calls.length, baseline);
  assert.equal(f.owner.getStats().ready, true);
  assert.equal(f.errors.length, 30);
  await f.owner.stop();
});

test('callbacks for a stopping epoch cannot enqueue PCM, grant credits or revive calibration', async () => {
  const native = deferred(), f = fixture({ nativeStop: () => native.promise });
  await f.owner.start('selected');
  f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 });
  const stopping = f.owner.stop();
  assert.equal(f.emit(pcm()), true);
  assert.equal(f.owner.getStats().stoppingPackets, 1);
  assert.equal(f.packets.length, 0);
  assert.equal(f.owner.grantCredits({ epoch: 1, grantSequence: 2, frames: 480 }), false);
  assert.equal(f.owner.feedback({ epoch: 1, available: false }), false);
  assert.throws(() => f.owner.probe({ epoch: 1, probeId: 1 }), /stopped/u);
  assert.equal(f.count('probe'), 0);
  assert.equal(f.count('feedback'), 0);
  native.resolve({});
  await stopping;
});

test('malformed, shared, non-finite, future and discontinuous PCM fails inside the synchronous native callback', async t => {
  const malformed = [
    ['missing samples', packet => { delete packet.samples; }],
    ['wrong typed array', packet => { packet.samples = new Float64Array(960); }],
    ['short PCM', packet => { packet.samples = new Float32Array(959); }],
    ['shared PCM', packet => { packet.samples = new Float32Array(new SharedArrayBuffer(3840)); }],
    ['NaN PCM', packet => { packet.samples[10] = NaN; }],
    ['infinite PCM', packet => { packet.samples[10] = Infinity; }],
    ['wrong frame count', packet => { packet.frames = 960; }],
    ['wrong rate', packet => { packet.sampleRate = 44100; }],
    ['wrong channels', packet => { packet.channels = 1; }],
    ['nonzero first sequence', packet => { packet.sequence = 1; }],
    ['skipped initial sample position', packet => { packet.firstPlayoutFrame = 480; }],
    ['unsafe sequence successor', packet => { packet.sequence = Number.MAX_SAFE_INTEGER; }],
    ['unsafe frame successor', packet => { packet.firstPlayoutFrame = Number.MAX_SAFE_INTEGER; }],
    ['negative sequence', packet => { packet.sequence = -1; }],
    ['missing epoch', packet => { delete packet.epoch; }],
    ['invalid epoch', packet => { packet.epoch = 0; }],
    ['future epoch', packet => { packet.epoch = 2; }],
  ];
  for (const [name, mutate] of malformed) {
    await t.test(name, async () => {
      const f = fixture();
      await f.owner.start('selected');
      f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 960 });
      const packet = pcm();
      mutate(packet);
      assert.equal(f.emit(packet), true);
      assert.equal(f.packets.length, 0);
      assert.ok(f.errors.length > 0);
      assert.equal(f.owner.getStats().ready, false);
      await f.owner.stop();
    });
  }
});

test('wrong event targets and uncredited or duplicate PCM cannot bypass packet accounting', async t => {
  for (const scenario of ['target', 'no-credit', 'duplicate', 'skipped']) {
    await t.test(scenario, async () => {
      const f = fixture();
      await f.owner.start('selected');
      if (scenario !== 'no-credit') f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 960 });
      if (scenario === 'target') {
        assert.equal(f.owner.handleNativeEvent({ type: 'audio.playout', target: 11, data: pcm() }), true);
      } else if (scenario === 'no-credit') f.emit(pcm());
      else { f.emit(pcm()); f.emit(pcm(1, scenario === 'duplicate' ? 0 : 2)); }
      assert.ok(f.errors.length > 0);
      assert.equal(f.packets.length, ['duplicate', 'skipped'].includes(scenario) ? 1 : 0);
      await f.owner.stop();
    });
  }
});

test('credits obey 480/960-frame grants, consecutive identities and the shared 1920-frame bound', async t => {
  for (const [name, grants] of [
    ['first sequence is one', [{ grantSequence: 2, frames: 480 }]],
    ['duplicate identity', [{ grantSequence: 1, frames: 480 }, { grantSequence: 1, frames: 480 }]],
    ['skipped identity', [{ grantSequence: 1, frames: 480 }, { grantSequence: 3, frames: 480 }]],
    ['partial quantum', [{ grantSequence: 1, frames: 128 }]],
    ['oversized grant', [{ grantSequence: 1, frames: 1920 }]],
    ['capacity overflow', [{ grantSequence: 1, frames: 960 }, { grantSequence: 2, frames: 960 }, { grantSequence: 3, frames: 480 }]],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      await f.owner.start('selected');
      for (const grant of grants.slice(0, -1)) f.owner.grantCredits({ epoch: 1, ...grant });
      assert.throws(() => f.owner.grantCredits({ epoch: 1, ...grants.at(-1) }), /credit/u);
      assert.equal(f.count('grant'), grants.length - 1);
      assert.ok(f.owner.getStats().reservedFrames <= 1920);
      await f.owner.stop();
    });
  }
});

test('four pending FIFO enqueues consume capacity; packet routing never waits for physical playback', async () => {
  const queue = deferred(), f = fixture({ enqueue: () => queue.promise });
  await f.owner.start('selected');
  f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 960 });
  f.owner.grantCredits({ epoch: 1, grantSequence: 2, frames: 960 });
  for (let sequence = 0; sequence < 4; sequence++) assert.equal(f.emit(pcm(1, sequence)), true);
  assert.equal(f.owner.getStats().pendingEnqueues, 4);
  assert.equal(f.owner.getStats().reservedFrames, 1920);
  const probe = f.owner.probe({ epoch: 1, probeId: 1 });
  assert.equal(probe.rtcBeforeUs, 2000000, 'Clock controls are not queued behind any playback-completion promise');
  assert.throws(() => f.owner.grantCredits({ epoch: 1, grantSequence: 3, frames: 480 }), /capacity/u);
  queue.resolve();
  await f.owner.stop();
  assert.equal(f.owner.getStats().pendingEnqueues, 0);
  assert.equal(f.owner.getStats().enqueuedPackets, 4);
});

test('enqueue rejection and synchronous admission failure are observed even when Node ignores callback return values', async t => {
  for (const asynchronous of [false, true]) {
    await t.test(asynchronous ? 'asynchronous rejection' : 'synchronous throw', async () => {
      const failure = new Error('Double renderer FIFO failed');
      const f = fixture({ enqueue: () => { if (asynchronous) return Promise.reject(failure); throw failure; } });
      await f.owner.start('selected');
      f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 });
      assert.equal(f.emit(pcm()), true);
      await tick();
      assert.ok(f.errors.some(entry => entry.error === failure && entry.context.phase === 'renderer.enqueue'));
      assert.equal(f.owner.getStats().enqueueUncertain, true);
      assert.equal(f.owner.getStats().stopped, true);
      assert.equal(f.count('engine.close'), 0);
    });
  }
});

test('probe and calibration forward native results intact and never accept renderer-supplied native clock values', async () => {
  const observation = { epoch: 1, probeId: 7, rtcBeforeUs: 9876500, rtcAfterUs: 9876520 };
  const calibration = { epoch: 1, calibrationId: 4, offsetUs: -700.25, uncertaintyUs: 16020.5 };
  const f = fixture({ probe: () => observation, calibrate: () => calibration });
  await f.owner.start('selected');
  assert.equal(f.owner.probe({ epoch: 1, probeId: 7 }), observation);
  const bracket = { epoch: 1, probeId: 7, rendererBeforeUs: 1000000, rendererAfterUs: 1000800 };
  assert.throws(() => f.owner.calibrate({ ...bracket, rtcBeforeUs: 1, rtcAfterUs: 2 }), /payload/u);
  assert.throws(() => f.owner.calibrate({ ...bracket, offsetUs: 0 }), /payload/u);
  assert.equal(f.count('calibrate'), 0);
  assert.equal(f.owner.calibrate(bracket), calibration);
  assert.deepEqual(f.calls.find(call => call.type === 'calibrate').data, bracket);
  assert.equal(f.owner.getStats().calibrationId, 4);
  assert.equal(f.owner.getStats().pendingProbes, 0);
  await f.owner.stop();
});

test('actual renderer clock-client brackets and converted feedback reach native without clock synthesis or negative clamping', async () => {
  const f = fixture();
  await f.owner.start('selected');
  f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 960 });
  f.emit(pcm());
  f.emit(pcm(1, 1));
  let now = 1000.123, scheduled = null;
  const errors = [];
  const clock = new NativeAudioClockClient({
    epoch: 1, now: () => now,
    async requestProbe(data) { const result = f.owner.probe(data); now += 0.5; return result; },
    async calibrate(data) { return f.owner.calibrate(data); },
    sendFeedback: data => f.owner.feedback(data), onError: error => errors.push(error),
    setTimer(callback) { scheduled = callback; return 1; }, clearTimer() { scheduled = null; },
  });
  await clock.start();
  assert.deepEqual(f.calls.find(call => call.type === 'calibrate').data, {
    epoch: 1, probeId: 1, rendererBeforeUs: 1000123, rendererAfterUs: 1000623,
  });
  clock.feedback({
    epoch: 1, available: true, clockEpoch: 1, atPerformanceTimeMs: now,
    estimatedPlayoutFrame: -240.5, confirmedPcmEnd: 960, feedbackAgeMs: 0.25, outputClockAgeMs: 0.5,
  });
  assert.deepEqual(f.calls.find(call => call.type === 'feedback').data, {
    epoch: 1, available: true, clockEpoch: 1, calibrationId: 1, atPerformanceTimeUs: 1000623,
    estimatedPlayoutFrame: -240.5, confirmedPcmEnd: 960, feedbackAgeUs: 250, outputClockAgeUs: 500,
  });
  clock.feedback({ epoch: 1, available: false, reason: 'no-physical-anchor' });
  assert.deepEqual(f.calls.filter(call => call.type === 'feedback').at(-1).data, { epoch: 1, available: false });
  assert.deepEqual(errors, []);
  clock.stop();
  assert.equal(scheduled, null);
  await f.owner.stop();
});

test('native clock expiry withdraws measurement and recalibrates without retiring live audio or video', async () => {
    const f = fixture();
    await f.owner.start('selected');
    let now = 1000;
    const errors = [];
    const clock = new NativeAudioClockClient({
      epoch: 1, now: () => now,
      async requestProbe(data) { const result = f.owner.probe(data); now += .5; return result; },
      async calibrate(data) { return f.owner.calibrate(data); },
      sendFeedback: data => f.owner.feedback(data), onError: error => errors.push(error),
      setTimer() { return 1; }, clearTimer() {},
    });
    await clock.start();
    const expired = () => Object.assign(new Error('Clock calibration is stale or uncertain'), {
      code: 'ERR_RTC_AUDIO_CLOCK_OBSERVATION', status: 8,
    });
    f.hooks.calibrate = () => { throw expired(); };
    now += 100;
    assert.equal(await clock.refresh(), false);
    assert.equal(clock.getStats().lastUnavailableReason, 'native-observation-expired');
    assert.equal(f.owner.getStats().ready, true);
    f.hooks.calibrate = undefined;
    now += 100;
    assert.equal(await clock.refresh(), true);
    f.hooks.feedback = () => { throw expired(); };
    const feedback = { epoch: 1, available: true, clockEpoch: 1, atPerformanceTimeMs: now,
      estimatedPlayoutFrame: 0, confirmedPcmEnd: 0, feedbackAgeMs: 0, outputClockAgeMs: 0 };
    assert.equal(clock.feedback(feedback), false);
    assert.equal(f.owner.getStats().rejectedClockObservations, 2);
    assert.equal(f.owner.getStats().lastClockRejection.phase, 'feedback');
    assert.equal(f.owner.getStats().activeEpoch, 1);
    assert.equal(f.owner.getStats().ready, true);
    assert.equal(f.count('audio.stopOutput'), 0);
    assert.equal(f.count('engine.close'), 0);
    f.hooks.feedback = undefined;
    assert.equal(clock.feedback(feedback), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(f.errors, []);
    clock.stop();
    await f.owner.stop();
  });

test('unclassified native clock errors remain fatal instead of being silently retried', async () => {
    const failure = Object.assign(new Error('Physical audio feedback is beyond actual PCM'), {
      code: 'ERR_RTC_AUDIO', status: 2,
    });
    const f = fixture({ feedback() { throw failure; } });
    await f.owner.start('selected');
    assert.throws(() => f.owner.feedback({ epoch: 1, available: false }), error => error === failure);
    await f.owner.stop();
    assert.equal(f.owner.getStats().stopped, true);
    assert.ok(f.errors.some(value => containsError(value.error, /beyond actual PCM/)));
  });

test('repeated delayed renderer probes expire only when a new native observation proves their retirement', async () => {
  let now = 1000, slow = false;
  const f = fixture({
    probe: data => ({ ...data, rtcBeforeUs: Math.round(now * 1000), rtcAfterUs: Math.round(now * 1000) }),
  });
  await f.owner.start('selected');
  const errors = [];
  const clock = new NativeAudioClockClient({
    epoch: 1, now: () => now,
    async requestProbe(data) { const result = f.owner.probe(data); now += slow ? 9 : .5; return result; },
    async calibrate(data) { return f.owner.calibrate(data); },
    sendFeedback: data => f.owner.feedback(data), onError: error => errors.push(error),
    setTimer() { return 1; }, clearTimer() {},
  });
  await clock.start();
  slow = true;
  for (let attempt = 0; attempt < 40; attempt++) {
    now += 100;
    assert.equal(await clock.refresh(), false);
    assert.ok(f.owner.getStats().pendingProbes <= 2);
    clock.feedback({
      epoch: 1, available: true, clockEpoch: 1, atPerformanceTimeMs: now,
      estimatedPlayoutFrame: 0, confirmedPcmEnd: 0, feedbackAgeMs: 0, outputClockAgeMs: 0,
    });
    assert.deepEqual(f.calls.filter(call => call.type === 'feedback').at(-1).data, { epoch: 1, available: false });
  }
  assert.equal(f.owner.getStats().expiredProbes, 38);
  assert.equal(f.owner.getStats().ready, true);
  assert.equal(f.count('audio.stopOutput'), 0);
  slow = false;
  now += 201;
  assert.equal(await clock.refresh(), true);
  assert.equal(f.owner.getStats().pendingProbes, 0);
  assert.equal(f.owner.getStats().expiredProbes, 40);
  assert.equal(clock.getStats().calibrationId, 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(f.errors, []);
  clock.stop();
  await f.owner.stop();
});

test('probe expiry mirrors the native strict 200ms bound without using the renderer clock', async () => {
  let now = 0;
  const f = fixture({ probe: data => ({ ...data, rtcBeforeUs: now, rtcAfterUs: now }) });
  await f.owner.start('selected');
  f.owner.probe({ epoch: 1, probeId: 1 });
  now = 200000;
  f.owner.probe({ epoch: 1, probeId: 2 });
  assert.equal(f.owner.getStats().pendingProbes, 2);
  assert.equal(f.owner.getStats().expiredProbes, 0);
  now++;
  f.owner.probe({ epoch: 1, probeId: 3 });
  assert.equal(f.owner.getStats().pendingProbes, 2);
  assert.equal(f.owner.getStats().expiredProbes, 1);
  assert.throws(() => f.owner.calibrate({
    epoch: 1, probeId: 1, rendererBeforeUs: 1, rendererAfterUs: 2,
  }), /owned native probe/u);
  assert.equal(f.count('calibrate'), 0);
  await f.owner.stop();
});

test('unknown probes, reused probes and excess outstanding probes never reach native calibration/admission', async t => {
  await t.test('no owned probe', async () => {
    const f = fixture();
    await f.owner.start('selected');
    assert.throws(() => f.owner.calibrate({ epoch: 1, probeId: 1, rendererBeforeUs: 1, rendererAfterUs: 2 }), /owned native probe/u);
    assert.equal(f.count('calibrate'), 0);
    await f.owner.stop();
  });
  await t.test('duplicate probe', async () => {
    const f = fixture();
    await f.owner.start('selected');
    f.owner.probe({ epoch: 1, probeId: 1 });
    assert.throws(() => f.owner.probe({ epoch: 1, probeId: 1 }), /reused/u);
    assert.equal(f.count('probe'), 1);
    await f.owner.stop();
  });
  await t.test('bounded outstanding observations', async () => {
    const f = fixture();
    await f.owner.start('selected');
    for (let probeId = 1; probeId <= 16; probeId++) f.owner.probe({ epoch: 1, probeId });
    assert.equal(f.owner.getStats().pendingProbes, 16);
    assert.throws(() => f.owner.probe({ epoch: 1, probeId: 17 }), /capacity/u);
    assert.equal(f.count('probe'), 16);
    await f.owner.stop();
  });
});

test('a reentrant calibration cannot consume a native probe before its actual observation has returned', async () => {
  const f = fixture({
    probe(data, { owner }) {
      assert.equal(owner.getStats().pendingProbes, 1);
      assert.throws(() => owner.calibrate({
        epoch: data.epoch, probeId: data.probeId, rendererBeforeUs: 1, rendererAfterUs: 2,
      }), /owned native probe/u);
      return { ...data, rtcBeforeUs: 1000, rtcAfterUs: 1001 };
    },
  });
  await f.owner.start('selected');
  assert.throws(() => f.owner.probe({ epoch: 1, probeId: 1 }), /owned native probe/u);
  assert.equal(f.count('calibrate'), 0);
  await f.owner.stop();
});

test('wrong native observations or calibration results invalidate output rather than manufacturing usable clocks', async t => {
  for (const [name, hooks, action] of [
    ['wrong probe epoch', { probe: data => ({ ...data, epoch: 2, rtcBeforeUs: 10, rtcAfterUs: 20 }) }, 'probe'],
    ['backward native bracket', { probe: data => ({ ...data, rtcBeforeUs: 20, rtcAfterUs: 10 }) }, 'probe'],
    ['excess native span', { probe: data => ({ ...data, rtcBeforeUs: 10, rtcAfterUs: 20011 }) }, 'probe'],
    ['missing native readings', { probe: data => ({ ...data }) }, 'probe'],
    ['wrong calibration epoch', { calibrate: () => ({ epoch: 2, calibrationId: 1, offsetUs: 1, uncertaintyUs: 16000 }) }, 'calibrate'],
    ['nonfinite calibration', { calibrate: () => ({ epoch: 1, calibrationId: 1, offsetUs: NaN, uncertaintyUs: 16000 }) }, 'calibrate'],
    ['excess calibration uncertainty', { calibrate: () => ({ epoch: 1, calibrationId: 1, offsetUs: 1, uncertaintyUs: 20001 }) }, 'calibrate'],
  ]) {
    await t.test(name, async () => {
      const f = fixture(hooks);
      await f.owner.start('selected');
      if (action === 'probe') assert.throws(() => f.owner.probe({ epoch: 1, probeId: 1 }), /native|Native/u);
      else {
        f.owner.probe({ epoch: 1, probeId: 1 });
        assert.throws(() => f.owner.calibrate({ epoch: 1, probeId: 1, rendererBeforeUs: 1, rendererAfterUs: 2 }), /native|Native/u);
      }
      assert.equal(f.owner.getStats().ready, false);
      assert.equal(f.owner.getStats().calibrationId, null);
      await f.owner.stop();
    });
  }
});

test('available feedback requires current calibration, valid measured bounds and the actual PCM cursor', async t => {
  for (const [name, changes] of [
    ['wrong calibration', { calibrationId: 99 }],
    ['invalid graph epoch', { clockEpoch: 0 }],
    ['unconfirmed PCM', { confirmedPcmEnd: 481 }],
    ['estimate beyond confirmed cursor', { estimatedPlayoutFrame: 481 }],
    ['nonfinite estimate', { estimatedPlayoutFrame: NaN }],
    ['negative observation time', { atPerformanceTimeUs: -1 }],
    ['invalid feedback age', { feedbackAgeUs: -1 }],
    ['invalid output clock age', { outputClockAgeUs: Infinity }],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      await f.owner.start('selected');
      f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 });
      f.emit(pcm());
      f.owner.probe({ epoch: 1, probeId: 1 });
      f.owner.calibrate({ epoch: 1, probeId: 1, rendererBeforeUs: 1, rendererAfterUs: 2 });
      assert.throws(() => f.owner.feedback({
        epoch: 1, available: true, clockEpoch: 1, calibrationId: 1, atPerformanceTimeUs: 100,
        estimatedPlayoutFrame: -240, confirmedPcmEnd: 480, feedbackAgeUs: 0, outputClockAgeUs: 0, ...changes,
      }), /feedback/u);
      assert.equal(f.count('feedback'), 0);
      assert.equal(f.owner.getStats().rejectedFeedback, null);
      await f.owner.stop();
    });
  }
});

test('feedback diagnostics retain only separate bounded copies of actual accepted and native-rejected observations', async () => {
  const f = fixture();
  await f.owner.start('selected');
  f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 });
  f.emit(pcm());
  f.owner.probe({ epoch: 1, probeId: 1 });
  f.owner.calibrate({ epoch: 1, probeId: 1, rendererBeforeUs: 1, rendererAfterUs: 2 });
  const first = {
    epoch: 1, available: true, clockEpoch: 1, calibrationId: 1, atPerformanceTimeUs: 214300,
    estimatedPlayoutFrame: -479.36, confirmedPcmEnd: 480, feedbackAgeUs: 0, outputClockAgeUs: 100,
  };
  assert.equal(f.owner.feedback(first), true);
  const accepted = { ...first };
  first.estimatedPlayoutFrame = 0;
  const failure = new Error('Modeled native physical clock regression');
  f.hooks.feedback = () => { throw failure; };
  const rejected = { ...accepted, atPerformanceTimeUs: 224800, estimatedPlayoutFrame: -500.096 };
  assert.throws(() => f.owner.feedback(rejected), error => error === failure);
  const stats = f.owner.getStats();
  assert.deepEqual(stats.lastFeedback, accepted);
  assert.deepEqual(stats.rejectedFeedback, rejected);
  stats.lastFeedback.estimatedPlayoutFrame = 999;
  stats.rejectedFeedback.estimatedPlayoutFrame = 999;
  assert.deepEqual(f.owner.getStats().lastFeedback, accepted);
  assert.deepEqual(f.owner.getStats().rejectedFeedback, rejected);
  await f.owner.stop();
  await f.owner.start('selected');
  assert.equal(f.owner.getStats().lastFeedback, null);
  assert.equal(f.owner.getStats().rejectedFeedback, null);
  await f.owner.stop();
});

test('native PCM diagnostics distinguish real silence from unavailable data and preserve anti-phase energy', async () => {
  const f = fixture();
  assert.equal(f.owner.getStats().pcmSignal, null);
  await f.owner.start('selected');
  assert.equal(f.owner.getStats().pcmSignal.leftRms, null);
  const samples = Float32Array.from({ length: 960 }, (_, index) => index % 2 ? -.25 : .25);
  f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 960 });
  f.emit(pcm(1, 0, { samples }));
  const active = f.owner.getStats().pcmSignal;
  assert.equal(active.measurementPoint, 'native-mixer-output-before-renderer');
  assert.equal(active.frames, 480);
  assert.equal(active.nonzeroFrames, 480);
  assert.equal(active.leftRms, .25);
  assert.equal(active.rightRms, .25);
  assert.equal(active.normalizedCrossCorrelation, -1);
  f.emit(pcm(1, 1, { samples: new Float32Array(960) }));
  const withSilence = f.owner.getStats().pcmSignal;
  assert.equal(withSilence.frames, 960);
  assert.equal(withSilence.nonzeroFrames, 480);
  assert.equal(withSilence.leftRms, Math.sqrt(.25 * .25 / 2));
  assert.equal(withSilence.normalizedCrossCorrelation, -1);
  withSilence.leftSquareSum = 999;
  assert.equal(f.owner.getStats().pcmSignal.leftSquareSum, 30);
  await f.owner.stop();
  await f.owner.start('selected');
  f.owner.grantCredits({ epoch: 2, grantSequence: 1, frames: 480 });
  f.emit(pcm(2, 0, { samples: new Float32Array(960) }));
  const silent = f.owner.getStats().pcmSignal;
  assert.equal(silent.frames, 480);
  assert.equal(silent.leftRms, 0);
  assert.equal(silent.rightRms, 0);
  assert.equal(silent.normalizedCrossCorrelation, null);
  await f.owner.stop();
});

test('independent stereo tones do not acquire a manufactured mono or anti-phase correlation', async () => {
  const f = fixture();
  await f.owner.start('selected');
  const samples = new Float32Array(960);
  for (let frame = 0; frame < 480; frame++) {
    samples[2 * frame] = .5 * Math.cos(2 * Math.PI * 4 * frame / 480);
    samples[2 * frame + 1] = .5 * Math.cos(2 * Math.PI * 7 * frame / 480);
  }
  f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 });
  f.emit(pcm(1, 0, { samples }));
  const signal = f.owner.getStats().pcmSignal;
  assert.ok(Math.abs(signal.leftRms - .5 / Math.sqrt(2)) < 1e-7);
  assert.ok(Math.abs(signal.rightRms - .5 / Math.sqrt(2)) < 1e-7);
  assert.ok(Math.abs(signal.normalizedCrossCorrelation) < 1e-7);
  assert.equal(signal.leftPeak, .5);
  assert.equal(signal.rightPeak, .5);
  await f.owner.stop();
});

test('native synchronous control failures invalidate output with original diagnostics and no guessed stale-code proof', async t => {
  for (const method of ['probe', 'calibrate', 'feedback']) {
    await t.test(method, async () => {
      const failure = Object.assign(new Error('Double native output is stale'), { code: 'DOUBLE_UNKNOWN_STALE_CODE' });
      const f = fixture();
      await f.owner.start('selected');
      if (method === 'calibrate') f.owner.probe({ epoch: 1, probeId: 1 });
      f.hooks[method] = () => { throw failure; };
      if (method === 'probe') assert.throws(() => f.owner.probe({ epoch: 1, probeId: 1 }), failure);
      if (method === 'calibrate') assert.throws(() => f.owner.calibrate({
        epoch: 1, probeId: 1, rendererBeforeUs: 1, rendererAfterUs: 2,
      }), failure);
      if (method === 'feedback') assert.throws(() => f.owner.feedback({ epoch: 1, available: false }), failure);
      assert.equal(f.owner.getStats().nativeRetired, false);
      assert.equal(f.owner.getStats().engineClosed, false);
      assert.ok(f.errors.some(entry => entry.error === failure && entry.context.epoch === 1 && entry.context.phase === method));
      await f.owner.stop();
      assert.equal(f.count('audio.stopOutput'), 1);
    });
  }
});

test('asynchronous impostors for direct native methods are rejected and their later failures are observed', async t => {
  for (const method of ['grant', 'probe', 'calibrate', 'feedback']) {
    await t.test(method, async () => {
      const failure = new Error(`Double ${method} asynchronous rejection`);
      const f = fixture();
      await f.owner.start('selected');
      if (method === 'calibrate') f.owner.probe({ epoch: 1, probeId: 1 });
      f.hooks[method] = () => Promise.reject(failure);
      assert.throws(() => {
        if (method === 'grant') f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 });
        if (method === 'probe') f.owner.probe({ epoch: 1, probeId: 1 });
        if (method === 'calibrate') f.owner.calibrate({ epoch: 1, probeId: 1, rendererBeforeUs: 1, rendererAfterUs: 2 });
        if (method === 'feedback') f.owner.feedback({ epoch: 1, available: false });
      }, /synchronous/u);
      await f.owner.stop();
      await tick();
      assert.ok(f.errors.some(entry => entry.error === failure));
    });
  }
});

test('renderer cleanup failure does not skip native retirement and retries only the unretired renderer', async () => {
  const failure = new Error('Double context close failed'), f = fixture({ rendererStop: () => Promise.reject(failure) });
  await f.owner.start('selected');
  await rejectsWith(f.owner.stop(), /context close failed/u);
  assert.equal(f.count('audio.stopOutput'), 1);
  assert.equal(f.owner.getStats().nativeRetired, true);
  assert.equal(f.owner.getStats().rendererRetired, false);
  await assert.rejects(f.owner.start('replacement'), /still owns/u);
  f.hooks.rendererStop = undefined;
  await f.owner.stop();
  assert.equal(f.count('audio.stopOutput'), 1);
  assert.equal(f.count('renderer.stop'), 2);
  assert.equal(f.owner.getStats().stopped, true);
});

test('native cleanup rejection, including ERR_RTC_ENGINE_CLOSED, retains ownership despite successful renderer stop', async () => {
  const failure = Object.assign(new Error('Double native close is not proven'), { code: 'ERR_RTC_ENGINE_CLOSED' });
  const f = fixture({ nativeStop: () => Promise.reject(failure) });
  await f.owner.start('selected');
  f.owner.handleNativeEvent(outputError());
  await rejectsWith(f.owner.stop(), /not proven/u);
  assert.equal(f.owner.getStats().rendererRetired, true);
  assert.equal(f.owner.getStats().nativeRetired, false);
  assert.equal(f.owner.getStats().engineClosed, false);
  await assert.rejects(f.owner.start('replacement'), /still owns/u);
  f.hooks.nativeStop = undefined;
  await f.owner.stop();
  assert.equal(f.count('renderer.stop'), 1);
  assert.equal(f.count('audio.stopOutput'), 2);
  assert.equal(f.owner.getStats().stopped, true);
});

test('both cleanup failures are retained and retried without skipping either independent retirement', async () => {
  const f = fixture({
    rendererStop: () => Promise.reject(new Error('Double renderer close failed')),
    nativeStop: () => Promise.reject(new Error('Double native stop failed')),
  });
  await f.owner.start('selected');
  await assert.rejects(f.owner.stop(), error => error instanceof AggregateError && error.errors.length === 2);
  assert.equal(f.count('audio.stopOutput'), 1);
  assert.equal(f.count('renderer.stop'), 1);
  assert.equal(f.owner.getStats().nativeRetired, false);
  assert.equal(f.owner.getStats().rendererRetired, false);
  f.hooks.rendererStop = f.hooks.nativeStop = undefined;
  await f.owner.stop();
  assert.equal(f.owner.getStats().stopped, true);
  assert.ok(f.errors.some(entry => entry.context.phase === 'renderer.stop'));
  assert.ok(f.errors.some(entry => entry.context.phase === 'native.stop'));
});

test('renderer ACKs and malformed native stop results cannot replace real retirement promises/results', async t => {
  for (const [name, hooks, pattern, nativeRetired] of [
    ['synchronous renderer ACK', { rendererStop: () => ({ closed: true }) }, /context-retirement Promise/u, true],
    ['native status-shaped ACK', { nativeStop: () => Promise.resolve({ closed: true }) }, /retirement result/u, false],
    ['native non-record result', { nativeStop: () => Promise.resolve(new Date(0)) }, /retirement result/u, false],
  ]) {
    await t.test(name, async () => {
      const f = fixture(hooks);
      await f.owner.start('selected');
      await rejectsWith(f.owner.stop(), pattern);
      assert.equal(f.owner.getStats().nativeRetired, nativeRetired);
      assert.equal(f.owner.getStats().stopped, false);
      f.hooks.rendererStop = f.hooks.nativeStop = undefined;
      await f.owner.stop();
      assert.equal(f.owner.getStats().stopped, true);
    });
  }
});

test('synchronous FIFO ACKs fail visibly instead of pretending to prove renderer admission', async () => {
  const f = fixture({ enqueue: () => ({ enqueued: true }) });
  await f.owner.start('selected');
  f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 });
  assert.equal(f.emit(pcm()), true);
  await tick();
  assert.ok(f.errors.some(entry => /FIFO enqueue Promise/u.test(entry.error.message)));
  assert.equal(f.owner.getStats().enqueueUncertain, true);
  assert.equal(f.owner.getStats().stopped, true);
});

test('timed-out native stop retains its actual in-flight promise and retry does not dispatch a duplicate', async () => {
  const native = deferred(), f = fixture({ nativeStop: () => native.promise }, 20);
  await f.owner.start('selected');
  await rejectsWith(f.owner.stop(), /stopOutput timed out/u);
  assert.equal(f.owner.getStats().nativeRetired, false);
  assert.equal(f.owner.getStats().rendererRetired, true);
  await assert.rejects(f.owner.start('replacement'), /still owns/u);
  const retry = f.owner.stop();
  native.resolve({});
  await retry;
  assert.equal(f.count('audio.stopOutput'), 1);
  assert.equal(f.owner.getStats().stopped, true);
});

test('timed-out renderer retirement never masquerades as closure and its late real completion releases ownership', async () => {
  const renderer = deferred(), f = fixture({ rendererStop: () => renderer.promise }, 20);
  await f.owner.start('selected');
  await rejectsWith(f.owner.stop(), /Renderer output stop timed out/u);
  assert.equal(f.owner.getStats().rendererRetired, false);
  assert.equal(f.owner.getStats().nativeRetired, true);
  await assert.rejects(f.owner.start('replacement'), /still owns/u);
  renderer.resolve();
  await tick();
  assert.equal(f.owner.getStats().stopped, true);
  f.hooks.rendererStop = undefined;
  assert.equal((await f.owner.start('replacement')).epoch, 2);
  await f.owner.stop();
});

test('full engine proof does not retire undrained renderer FIFO enqueues', async () => {
  const queue = deferred(), f = fixture({ enqueue: () => queue.promise }, 20);
  await f.owner.start('selected');
  f.owner.grantCredits({ epoch: 1, grantSequence: 1, frames: 480 });
  f.emit(pcm());
  await rejectsWith(f.owner.stop(), /enqueues have not drained/u);
  assert.equal(f.owner.getStats().pendingEnqueues, 1);
  const actualClose = f.commands.closeEngine();
  await rejectsWith(f.owner.finishAfterEngineClose(actualClose), /enqueues have not drained/u);
  assert.equal(f.owner.getStats().engineClosed, true);
  assert.equal(f.owner.getStats().nativeRetired, true);
  assert.equal(f.owner.getStats().stopped, false);
  queue.resolve();
  await tick();
  await f.owner.finishAfterEngineClose(actualClose);
  assert.equal(f.owner.getStats().state, 'closed');
  assert.equal(f.owner.getStats().pendingEnqueues, 0);
});

test('JSON closed events, arbitrary resolved promises and monkeypatched assertions are not engine retirement proof', async () => {
  const f = fixture();
  await f.owner.start('selected');
  assert.equal(f.owner.handleNativeEvent({ type: 'closed', target: 0, data: { closed: true } }), false);
  assert.equal(f.owner.getStats().ready, true);
  for (const invalid of [undefined, {}, { closed: true }, true]) {
    await assert.rejects(f.owner.finishAfterEngineClose(invalid), /actual native engine.close Promise/u);
  }
  f.commands.assertEngineClosed = () => {};
  await rejectsWith(f.owner.finishAfterEngineClose(Promise.resolve({ closed: true })), /has not been proven/u);
  assert.equal(f.owner.getStats().nativeRetired, false);
  assert.equal(f.owner.getStats().rendererRetired, true);
  assert.equal(f.count('engine.close'), 0);
  assert.equal(f.count('audio.stopOutput'), 0);
  const other = fixture();
  const otherClose = other.commands.closeEngine();
  await otherClose;
  await rejectsWith(f.owner.finishAfterEngineClose(otherClose), /has not been proven/u);
  assert.equal(f.owner.getStats().nativeRetired, false);
  await f.owner.finishAfterEngineClose(f.commands.closeEngine());
  assert.equal(f.owner.getStats().state, 'closed');
  assert.equal(f.count('engine.close'), 1);
  await assert.rejects(f.owner.start('replacement'), /closure has been requested/u);
});

test('finish waits for actual same-engine closure and concurrent forged proof cannot borrow a pending real close', async () => {
  const closed = deferred(), f = fixture({ close: () => closed.promise });
  await f.owner.start('selected');
  const actualClose = f.commands.closeEngine();
  const finishing = f.owner.finishAfterEngineClose(actualClose);
  let finished = false;
  void finishing.then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  assert.equal(f.owner.getStats().nativeRetired, false);
  assert.equal(f.owner.getStats().rendererRetired, true);
  await rejectsWith(f.owner.finishAfterEngineClose(Promise.resolve({ closed: true })), /has not been proven/u);
  assert.equal(finished, false);
  assert.equal(f.owner.getStats().nativeRetired, false);
  closed.resolve({ closed: true });
  await finishing;
  assert.equal(finished, true);
  assert.equal(f.owner.getStats().state, 'closed');
  assert.equal(f.count('audio.stopOutput'), 0);
});

test('a swallowed native close failure cannot forge proof and a real commands.closeEngine retry can finish', async () => {
  const close = deferred(), f = fixture({ close: () => close.promise });
  await f.owner.start('selected');
  const nativeClose = f.commands.closeEngine();
  const swallowed = nativeClose.catch(() => ({ closed: true }));
  const finishing = f.owner.finishAfterEngineClose(swallowed);
  const rejected = rejectsWith(finishing, /has not been proven/u);
  close.reject(new Error('Double full close failed'));
  await rejected;
  assert.equal(f.owner.getStats().engineClosed, false);
  assert.equal(f.owner.getStats().nativeRetired, false);
  f.hooks.close = undefined;
  await f.owner.finishAfterEngineClose(f.commands.closeEngine());
  assert.equal(f.count('engine.close'), 2);
  assert.equal(f.owner.getStats().state, 'closed');
});

test('true full-engine closure retires native uncertainty only; renderer stop still fails visibly and retries', async () => {
  const f = fixture({ rendererStop: () => Promise.reject(new Error('Double actual context is still open')) });
  await f.owner.start('selected');
  const actualClose = f.commands.closeEngine();
  await rejectsWith(f.owner.finishAfterEngineClose(actualClose), /context is still open/u);
  assert.equal(f.owner.getStats().nativeRetired, true);
  assert.equal(f.owner.getStats().rendererRetired, false);
  assert.equal(f.owner.getStats().stopped, false);
  assert.equal(f.count('audio.stopOutput'), 0);
  f.hooks.rendererStop = undefined;
  await f.owner.finishAfterEngineClose(actualClose);
  assert.equal(f.owner.getStats().state, 'closed');
  assert.equal(f.count('renderer.stop'), 2);
  assert.equal(f.count('engine.close'), 1);
});

test('full-close timeout retains ownership until a completed genuine proof is explicitly retried', async () => {
  const close = deferred(), f = fixture({ close: () => close.promise }, 20);
  await f.owner.start('selected');
  const actualClose = f.commands.closeEngine();
  await rejectsWith(f.owner.finishAfterEngineClose(actualClose), /proof timed out/u);
  assert.equal(f.owner.getStats().engineClosed, false);
  assert.equal(f.owner.getStats().nativeRetired, false);
  close.resolve({ closed: true });
  await actualClose;
  await f.owner.finishAfterEngineClose(actualClose);
  assert.equal(f.owner.getStats().state, 'closed');
});

test('closure during pending configure prevents late native reconfiguration or old-epoch stop after proven close', async () => {
  const configure = deferred(), f = fixture({ configure: () => configure.promise });
  const starting = f.owner.start('selected');
  const rejected = rejectsWith(starting, /stopped/u);
  await tick();
  await f.owner.finishAfterEngineClose(f.commands.closeEngine());
  await rejected;
  assert.equal(f.owner.getStats().state, 'closed');
  assert.equal(f.count('audio.stopOutput'), 0);
  configure.resolve({ epoch: 1, sampleRate: 48000, channels: 2 });
  await tick();
  assert.equal(f.owner.getStats().nativeConfigured, false);
  assert.equal(f.owner.getStats().state, 'closed');
  assert.equal(f.count('audio.stopOutput'), 0);
});

test('onError synchronous throws and rejected observer promises are observed without escaping native callbacks', async t => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => { logged.push(args); });
  for (const asynchronous of [false, true]) {
    const observerFailure = new Error('Double error observer failed');
    const f = fixture({ onError: () => { if (asynchronous) return Promise.reject(observerFailure); throw observerFailure; } });
    await f.owner.start('selected');
    assert.equal(f.emit(pcm()), true);
    await f.owner.stop();
    await tick();
    assert.ok(f.owner.getStats().observerErrors > 0);
    assert.ok(f.owner.getStats().errors.some(error => error.phase === 'onError' && error.message === observerFailure.message));
    assert.equal(Object.isFrozen(f.errors[0].context), true);
  }
  assert.equal(logged.length, 2);
});

test('NUL sink IDs consume no epoch, modeled channel or call; valid empty and 512-unit IDs still start', async t => {
  const f = fixture(), startRenderer = f.renderer.start.bind(f.renderer);
  let modeledChannels = 0;
  f.renderer.start = (config, signal) => {
    modeledChannels++;
    return startRenderer(config, signal);
  };
  t.after(() => f.owner.stop());
  for (const sinkId of ['\0', 'device\0suffix', 'x'.repeat(511) + '\0']) {
    await assert.rejects(f.owner.start(sinkId), /explicit Chromium sinkId/u);
    assert.equal(f.owner.getStats().lastEpoch, 0);
    assert.equal(f.owner.getStats().activeEpoch, null);
    assert.equal(f.owner.getStats().starts, 0);
    assert.equal(modeledChannels, 0);
    assert.equal(f.outputs.size, 0);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.errors, []);
  }
  for (const [index, sinkId] of ['selected-output', '', 'x'.repeat(512)].entries()) {
    const ready = await f.owner.start(sinkId);
    assert.equal(ready.epoch, index + 1);
    assert.equal(ready.sinkId, sinkId);
    assert.equal(modeledChannels, index + 1);
    await f.owner.stop();
  }
  assert.equal(f.owner.getStats().lastEpoch, 3);
});

test('invalid or cancelled starts never default a device, close the engine or affect voice/microphone/camera state', async () => {
  const f = fixture(), voice = Object.freeze({ deafened: false, microphoneMuted: false, cameraEnabled: true });
  const before = { ...voice }, controller = new AbortController();
  controller.abort();
  await assert.rejects(f.owner.start('explicit-device', controller.signal), { name: 'AbortError' });
  for (const sinkId of [undefined, null, 42, 'x'.repeat(513)]) {
    await assert.rejects(f.owner.start(sinkId), /explicit Chromium sinkId/u);
  }
  await assert.rejects(f.owner.start('explicit-device', {}), /AbortSignal/u);
  assert.deepEqual(f.calls, []);
  assert.equal(f.owner.getStats().lastEpoch, 0);
  await f.owner.start('opaque-user-selected-device');
  await f.owner.stop();
  assert.deepEqual(voice, before);
  assert.deepEqual([...new Set(f.calls.map(call => call.type))], [
    'renderer.start', 'renderer.selected', 'audio.configureOutput', 'renderer.ready', 'renderer.stop', 'audio.stopOutput',
  ]);
  assert.equal(f.count('engine.close'), 0);
});
