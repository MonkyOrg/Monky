'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NativeAudioOutputClock } = require('../runtime/nativeAudioOutputClock.cjs');

const feedback = (changes = {}) => ({
  epoch: 1, clockEpoch: 1, state: 'running', contextFrame: 48000, frames: 128,
  firstPlayoutFrame: 24000, mediaFrames: 128, queuedFrames: 832, ...changes,
});

function fixture() {
  let now = 1100;
  const clock = new NativeAudioOutputClock({ epoch: 1, now: () => now });
  const context = { state: 'running', sampleRate: 48000,
    getOutputTimestamp: () => ({ contextTime: .98, performanceTime: 1090 }) };
  return { clock, context, at: value => { now = value; } };
}

test('output clock relates PCM sample positions to the reported speaker clock, not currentTime or summed latency', () => {
  const f = fixture();
  f.clock.update(feedback());
  const sampled = f.clock.sample({
    ...f.context, currentTime: 1.02,
    get baseLatency() { assert.fail('getOutputTimestamp already supplies the output-clock relation.'); },
    get outputLatency() { assert.fail('Adding this again would double-count output latency.'); },
  });
  assert.equal(sampled.available, true);
  assert.equal(sampled.estimatedPlayoutFrame, 23520);
  assert.equal(sampled.confirmedPcmEnd, 24960);
  assert.equal(sampled.atPerformanceTimeMs, 1100);
  assert.equal(sampled.outputClockAgeMs, 10);
});

test('unknown, suspended or stale clocks stay explicitly unavailable rather than looking like zero delay', () => {
  const f = fixture();
  assert.equal(f.clock.sample(f.context).reason, 'no-render-anchor');
  f.clock.update(feedback());
  assert.equal(f.clock.sample({ state: 'suspended' }).reason, 'context-not-running');
  assert.equal(f.clock.sample({ state: 'running' }).reason, 'output-clock-unavailable');
  assert.equal(f.clock.sample({ ...f.context, sampleRate: 44100 }).reason, 'incompatible-output-format');
  assert.equal(f.clock.sample({ ...f.context, getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) })
    .reason, 'invalid-output-clock');
  f.at(1400);
  assert.equal(f.clock.sample(f.context).reason, 'stale-render-feedback');
  f.clock.update(feedback({ contextFrame: 48128, firstPlayoutFrame: 24128 }));
  assert.equal(f.clock.sample(f.context).reason, 'stale-output-clock');
});

test('a regressing physical startup estimate is unavailable, never clamped or promoted to a new clock epoch', () => {
  const f = fixture();
  f.at(214.3);
  f.clock.update(feedback({ contextFrame: 960, firstPlayoutFrame: 0, queuedFrames: 1312 }));
  f.context.getOutputTimestamp = () => ({ contextTime: (960 - 479.36) / 48000, performanceTime: 214.3 });
  const first = f.clock.sample(f.context);
  assert.equal(first.available, true);
  assert.ok(Math.abs(first.estimatedPlayoutFrame + 479.36) < 1e-9);
  f.at(224.8);
  f.clock.update(feedback({ contextFrame: 1472, firstPlayoutFrame: 512, queuedFrames: 1280 }));
  f.context.getOutputTimestamp = () => ({ contextTime: (960 - 500.096) / 48000, performanceTime: 224.8 });
  assert.deepEqual(f.clock.sample(f.context), { available: false, epoch: 1, reason: 'regressing-output-clock' });
  assert.equal(f.clock.getStats().regressedObservations, 1);
  assert.equal(f.clock.getStats().lastAccepted.clockEpoch, 1);
  f.at(235.3);
  f.clock.update(feedback({ contextFrame: 1984, firstPlayoutFrame: 1024, queuedFrames: 1280 }));
  f.context.getOutputTimestamp = () => ({ contextTime: (960 - 400.25) / 48000, performanceTime: 235.3 });
  const recovered = f.clock.sample(f.context);
  assert.equal(recovered.available, true);
  assert.ok(Math.abs(recovered.estimatedPlayoutFrame + 400.25) < 1e-9);
  assert.equal(recovered.clockEpoch, 1);
  assert.equal(f.clock.getStats().lastUnavailableReason, null);
});

test('physical observations need newer times and confirmed PCM unless a genuine graph epoch changes', () => {
  const f = fixture();
  f.clock.update(feedback());
  assert.equal(f.clock.sample(f.context).available, true);
  assert.equal(f.clock.sample(f.context).reason, 'regressing-output-clock');
  f.at(1101);
  f.clock.update(feedback({ contextFrame: 48128, firstPlayoutFrame: 24128, queuedFrames: 0 }));
  assert.equal(f.clock.sample(f.context).reason, 'regressing-output-clock');
  f.clock.update(feedback({ clockEpoch: 2, contextFrame: 48256, firstPlayoutFrame: 24128, queuedFrames: 0 }));
  assert.equal(f.clock.sample(f.context).available, true);
  f.clock.reset(2);
  assert.equal(f.clock.getStats().lastAccepted, null);
});

test('an underrun or replacement invalidates old anchors and delayed feedback cannot restore them', () => {
  const f = fixture();
  f.clock.update(feedback());
  f.clock.update(feedback({ clockEpoch: 2, contextFrame: 48128, state: 'buffering',
    firstPlayoutFrame: null, mediaFrames: 0 }));
  assert.equal(f.clock.sample(f.context).reason, 'buffering');
  assert.equal(f.clock.update(feedback({ contextFrame: 48256 })), false);
  assert.equal(f.clock.sample(f.context).reason, 'buffering');
  f.clock.reset(2);
  assert.equal(f.clock.update(feedback()), false);
  assert.equal(f.clock.sample(f.context).reason, 'no-render-anchor');
});

test('the clock never extrapolates through missing PCM as if an unseen underrun had not occurred', () => {
  const f = fixture();
  f.clock.update(feedback({ queuedFrames: 0 }));
  const sampled = f.clock.sample({
    ...f.context, getOutputTimestamp: () => ({ contextTime: 1.01, performanceTime: 1100 }),
  });
  assert.equal(sampled.available, false);
  assert.equal(sampled.reason, 'beyond-confirmed-pcm');
});

test('malformed feedback and non-monotonic browser/output clocks are rejected explicitly', () => {
  const f = fixture();
  for (const invalid of [
    feedback({ epoch: 2 }), feedback({ firstPlayoutFrame: null }), feedback({ mediaFrames: 0 }),
    feedback({ state: 'buffering' }), feedback({ queuedFrames: -1 }),
  ]) assert.throws(() => f.clock.update(invalid));
  f.clock.update(feedback());
  f.at(1090);
  assert.throws(() => f.clock.update(feedback({ contextFrame: 48128 })), /monotonic clock/u);
  assert.equal(f.clock.sample(f.context).reason, 'browser-clock-discontinuity');
  f.at(1100);
  assert.equal(f.clock.sample({
    ...f.context, getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 1200 }),
  }).reason, 'invalid-output-clock');
});
