'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { LiveSenderFlow } = require('../runtime/encodedSender.cjs');

function model() {
  const submitted = [], errors = [], calls = [];
  let now = 2000;
  const flow = new LiveSenderFlow({ sourceId: 7, initialBitrateKbps: 20000, fps: 120,
    onError: error => errors.push(error), now: () => now,
    engine: { submitEncodedFrame(sourceId, frame) {
      submitted.push(frame);
      return { copied: true, sourceId, frameId: frame.frameId, networkDeliveryConfirmed: false };
    } } });
  flow.bind({
    async setBitrate(value) { calls.push({ bitrate: value }); return { bitrateKbps: value, settingsAccepted: true, hardwareApplicationConfirmed: false }; },
    async requestKeyFrame() { calls.push({ idr: true }); return { mode: 'next-real-idr', keyframeConfirmed: false }; },
  });
  const frame = (id, keyframe = false) => ({ frameId: id, keyframe, data: Buffer.from([1, 2, 3]),
    timestampUs: 1000000 + id * 8333, durationUs: 8333, ntpTimeMs: -1, pts: String(id), dts: String(id - 1),
    timebaseNumerator: 1, timebaseDenominator: 120 });
  const feedback = (sequence, bitrate, paused = false, requestedFps = 120) => flow.feedback({ target: 7, data: {
    sourceId: 7, sequence, kind: 'rate', bitrateBps: bitrate, paused, keyframeConfirmed: false,
    requestedFps, fpsApplied: null, bitrateCeilingBps: 80000000,
  } });
  // keyint_sec=1 at 120fps; recovery tolerates three GOPs of encoded AUs.
  const bound = 360;
  let nextId = 1000;
  const deltas = count => { for (let index = 0; index < count; index++) flow.packet(frame(nextId++)); };
  return { flow, submitted, errors, calls, frame, feedback, bound, deltas, tick: value => { now = value; } };
}

test('a slow encoder stretching its GOP in wall time does not end the share', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.flow.packet(m.frame(1, true));
  m.flow.feedback({ target: 7, data: { sourceId: 7, sequence: 1, kind: 'recovery',
    reason: 'input-expired', frameId: 1, generation: 2,
    mode: 'next-real-idr', maximumWaitMs: 1500, keyframeConfirmed: false } });
  // An overloaded software encoder skips frames: one 120-AU GOP takes 4 s.
  for (let id = 2; id < 121; id++) { m.tick(2000 + id * 33); m.flow.packet(m.frame(id)); }
  assert.equal(m.submitted.length, 1);
  m.flow.packet(m.frame(121, true));
  assert.equal(m.submitted.length, 2);
  assert.equal(m.flow.snapshot().awaitedRecoveryFrames, 0);
  assert.equal(m.flow.snapshot().recoveryFrameBound, 360);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('the live sender requires its configured encoder frame rate', () => {
  for (const fps of [undefined, 0, 59.94, 241]) {
    assert.throws(() => new LiveSenderFlow({ sourceId: 7, initialBitrateKbps: 1000, fps, onError() {},
      engine: { submitEncodedFrame() {} } }), /configured encoder frame rate/);
  }
});

test('no watcher means no native submission; initial/resumed admission waits for actual IDR', async () => {
  const m = model();
  m.flow.packet(m.frame(1, true)); assert.equal(m.submitted.length, 0);
  m.flow.setConnected(true); m.flow.setDemand(true);
  m.flow.packet(m.frame(2)); assert.equal(m.submitted.length, 0);
  const key = m.frame(3, true); m.flow.packet(key);
  assert.equal(m.submitted[0].data, key.data); assert.equal(m.submitted[0].pts, '3'); assert.equal(m.submitted[0].dts, '2');
  m.feedback(1, 0, true); m.flow.packet(m.frame(4, true)); assert.equal(m.submitted.length, 1);
  assert.equal(m.flow.snapshot().pausedPackets, 1); assert.equal(m.flow.snapshot().paused, true);
  m.feedback(2, 20000000); m.flow.packet(m.frame(5)); assert.equal(m.submitted.length, 1);
  assert.equal(m.flow.snapshot().pausedPackets, 1); assert.equal(m.flow.snapshot().paused, false);
  m.flow.packet(m.frame(6, true)); assert.equal(m.submitted.length, 2);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('a minimized source discards paused AUs and resumes only on an unchanged real IDR', async () => {
  const m = model();
  m.flow.setConnected(true); m.flow.setDemand(true);
  m.flow.packet(m.frame(1, true));
  m.flow.setCapturePaused(true);
  m.tick(22000);
  m.flow.packet(m.frame(2, true));
  assert.equal(m.submitted.length, 1);
  assert.equal(m.flow.snapshot().sourcePausedPackets, 1);
  m.flow.setCapturePaused(false);
  m.flow.packet(m.frame(3));
  assert.equal(m.submitted.length, 1);
  const resumed = m.frame(4, true);
  m.flow.packet(resumed);
  assert.equal(m.submitted.length, 2);
  assert.equal(m.submitted[1].data, resumed.data);
  assert.equal(m.submitted[1].timestampUs, resumed.timestampUs);
  assert.equal(m.flow.snapshot().capturePaused, false);
  await m.flow.close();
  assert.deepEqual(m.errors, []);
});

test('a receiver PLI requests a keyframe without discarding the publisher existing valid chain', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.flow.packet(m.frame(1, true));
  m.flow.feedback({ target: 7, data: { sourceId: 7, sequence: 1, kind: 'keyframe',
    mode: 'next-real-idr', maximumWaitMs: 1500, keyframeConfirmed: false } });
  assert.equal(m.flow.needsIdr, false, 'A receiver request is not loss of the locally encoded chain.');
  m.tick(3700);
  const delta = m.frame(2);
  m.flow.packet(delta);
  assert.deepEqual(m.submitted[1], delta);
  m.flow.packet(m.frame(3, true));
  assert.equal(m.submitted.length, 3);
  assert.equal(m.calls.filter(call => call.idr).length, 1);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('a receiver PLI cannot clear or extend an actual dependency-recovery deadline', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.flow.packet(m.frame(1, true));
  m.flow.feedback({ target: 7, data: { sourceId: 7, sequence: 1, kind: 'recovery',
    reason: 'rtc-unconsumed', frameId: 1, generation: 2,
    mode: 'next-real-idr', maximumWaitMs: 1500, keyframeConfirmed: false } });
  m.flow.packet(m.frame(2));
  m.flow.feedback({ target: 7, data: { sourceId: 7, sequence: 2, kind: 'keyframe',
    mode: 'next-real-idr', maximumWaitMs: 1500, keyframeConfirmed: false } });
  assert.equal(m.flow.needsIdr, true);
  assert.equal(m.flow.awaitedFrames, 1);
  assert.equal(m.submitted.length, 1);
  m.deltas(m.bound - 1);
  assert.throws(() => m.flow.packet(m.frame(3)), /No real IDR/);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('real feedback reserves headroom and rounds down to AMF steps without claiming hardware application', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.feedback(1, 1234567);
  m.flow.packet(m.frame(1, true)); assert.equal(m.submitted.length, 1);
  await m.flow.rateWork;
  assert.deepEqual(m.calls, [{ bitrate: 1100 }]);
  m.flow.packet(m.frame(2)); assert.equal(m.submitted.length, 2);
  m.flow.packet(m.frame(3, true)); assert.equal(m.submitted.length, 3);
  assert.equal(m.flow.snapshot().currentSettingsKbps, 1100);
  assert.equal(m.flow.snapshot().feedback.allocationKbps, 1200);
  assert.deepEqual(m.flow.snapshot().bitratePolicy, { targetHeadroomPercent: 10, minimumIncreasePercent: 10 });
  assert.equal(m.flow.snapshot().queuedJavaScriptFrames, 0);
  await m.flow.close();
});

test('RTC burst-arrival estimates stay diagnostic and never retime the120fps encoded media', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  assert.equal(m.flow.snapshot().peakRtcArrivalFps, null);
  m.feedback(1, 5000000, false, 1000); await m.flow.rateWork;
  const keyframe = m.frame(1, true); m.flow.packet(keyframe);
  m.feedback(2, 5000000, false, 120);
  const delta = m.frame(2); m.flow.packet(delta);
  assert.equal(m.flow.snapshot().peakRtcArrivalFps, 1000);
  assert.equal(m.flow.snapshot().feedback.requestedFps, 120);
  assert.equal(m.flow.snapshot().feedback.fpsApplied, null);
  assert.deepEqual(m.calls, [{ bitrate: 4500 }]);
  for (const [index, frame] of [keyframe, delta].entries()) {
    assert.equal(m.submitted[index].timestampUs, frame.timestampUs);
    assert.equal(m.submitted[index].durationUs, frame.durationUs);
    assert.equal(m.submitted[index].timebaseDenominator, 120);
  }
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('invalid RTC arrival estimates fail explicitly without changing encoder settings', async () => {
  for (const fps of [-1, NaN, Infinity, 0x100000000]) {
    const m = model();
    assert.throws(() => m.feedback(1, 5000000, false, fps), /RTC arrival-rate estimate/);
    assert.equal(m.flow.snapshot().peakRtcArrivalFps, null);
    assert.deepEqual(m.calls, []);
    await m.flow.close();
  }
});

test('an explicit RTC pause suspends admission; missing IDR after resume still fails explicitly', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.feedback(1, 49999, true); m.flow.packet(m.frame(1, true)); assert.equal(m.submitted.length, 0);
  m.feedback(2, 20000000); m.flow.packet(m.frame(2));
  m.deltas(m.bound - 1); assert.throws(() => m.flow.packet(m.frame(3)), /No real IDR/);
  await m.flow.close();
});

test('a scheduled bitrate increase keeps sending at the lower applied setting instead of discarding a second of video', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.feedback(1, 1000000); await m.flow.rateWork;
  m.flow.packet(m.frame(1, true));
  m.feedback(2, 1500000);
  assert.equal(m.flow.currentKbps, 900); assert.equal(m.flow.desiredKbps, 1350);
  assert.ok(m.flow.rateTimer);
  m.flow.packet(m.frame(2)); assert.equal(m.submitted.length, 2);
  m.feedback(3, 500000);
  assert.equal(m.flow.rateTimer, null);
  assert.deepEqual(m.calls.at(-1), { bitrate: 450 });
  m.flow.packet(m.frame(3)); assert.equal(m.submitted.length, 3);
  await m.flow.rateWork;
  assert.equal(m.flow.currentKbps, 450);
  m.flow.packet(m.frame(4)); assert.equal(m.submitted.length, 4);
  m.flow.packet(m.frame(5, true)); assert.equal(m.submitted.length, 5);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('successive bitrate reductions bypass the one-second increase timer without bypassing feedback', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.feedback(1, 1000000); await m.flow.rateWork; m.flow.packet(m.frame(1, true));
  m.feedback(2, 1600000); assert.ok(m.flow.rateTimer);
  m.feedback(3, 850000); await m.flow.rateWork;
  assert.equal(m.flow.currentKbps, 750); assert.equal(m.flow.rateTimer, null);
  m.flow.packet(m.frame(2, true));
  m.feedback(4, 700000); assert.equal(m.flow.rateTimer, null);
  m.flow.packet(m.frame(3)); assert.equal(m.submitted.length, 3);
  await m.flow.rateWork; assert.equal(m.flow.currentKbps, 600);
  m.flow.packet(m.frame(4, true)); assert.equal(m.submitted.length, 4);
  assert.deepEqual(m.calls.filter(call => 'bitrate' in call).map(call => call.bitrate), [900, 750, 600]);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

for (const [direction, allocation, selected] of [['increase', 1500000, 1350], ['decrease', 700000, 600]]) {
  test(`a bitrate ${direction} preserves the H264 chain while settings are pending and after acknowledgement`, async () => {
    const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
    m.feedback(1, 1000000); await m.flow.rateWork; m.flow.packet(m.frame(1, true));
    let acknowledge;
    m.flow.host.setBitrate = value => new Promise(resolve => {
      m.calls.push({ bitrate: value });
      acknowledge = () => resolve({ bitrateKbps: value, settingsAccepted: true, hardwareApplicationConfirmed: false });
    });
    m.tick(3100); m.feedback(2, allocation);
    assert.equal(m.flow.applyingKbps, selected);
    m.flow.packet(m.frame(2));
    assert.equal(m.submitted.length, 2, 'Pending settings must not discard a valid dependent AU.');
    acknowledge(); await m.flow.rateWork;
    assert.equal(m.flow.currentKbps, selected); assert.equal(m.flow.needsIdr, false);
    m.flow.packet(m.frame(3)); m.flow.packet(m.frame(4, true)); m.flow.packet(m.frame(5));
    assert.equal(m.submitted.length, 5);
    assert.equal(m.flow.snapshot().pausedPackets, 0); assert.equal(m.flow.snapshot().awaitingIdr, 0);
    assert.equal(m.calls.filter(call => call.idr).length, 0, 'A rate change is not dependency loss or a PLI.');
    await m.flow.close(); assert.deepEqual(m.errors, []);
  });

  test(`a bitrate ${direction} cannot clear or extend a real dependency-recovery deadline`, async () => {
    const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
    m.feedback(1, 1000000); await m.flow.rateWork; m.flow.packet(m.frame(1, true));
    m.tick(3100);
    m.flow.feedback({ target: 7, data: { sourceId: 7, sequence: 2, kind: 'recovery',
      reason: 'rtc-unconsumed', frameId: 1, generation: 2,
      mode: 'next-real-idr', maximumWaitMs: 1500, keyframeConfirmed: false } });
    m.flow.packet(m.frame(2)); assert.equal(m.submitted.length, 1);
    m.tick(3500); m.feedback(3, allocation); await m.flow.rateWork;
    assert.equal(m.flow.needsIdr, true); assert.equal(m.flow.awaitedFrames, 1);
    m.deltas(m.bound - 1); assert.throws(() => m.flow.packet(m.frame(3)), /No real IDR/);
    await m.flow.close(); assert.deepEqual(m.errors, []);
  });
}

test('a reduction arriving during growth applies immediately after that acknowledgement without breaking the H264 chain', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.feedback(1, 1000000); await m.flow.rateWork; m.flow.packet(m.frame(1, true));
  const acknowledgements = [];
  m.flow.host.setBitrate = value => new Promise(resolve => {
    m.calls.push({ bitrate: value });
    acknowledgements.push(() => resolve({ bitrateKbps: value, settingsAccepted: true, hardwareApplicationConfirmed: false }));
  });
  m.tick(3100); m.feedback(2, 10000000); const increase = m.flow.rateWork;
  assert.equal(m.flow.applyingKbps, 9000);
  m.flow.packet(m.frame(2)); assert.equal(m.submitted.length, 2);
  m.feedback(3, 5000000);
  assert.equal(m.flow.desiredKbps, 4500);
  m.flow.packet(m.frame(3)); assert.equal(m.submitted.length, 3);
  acknowledgements[0](); await increase;
  assert.equal(m.flow.applyingKbps, 4500); assert.equal(m.flow.rateTimer, undefined);
  m.flow.packet(m.frame(4, true)); assert.equal(m.submitted.length, 4);
  const reduction = m.flow.rateWork; acknowledgements[1](); await reduction;
  assert.equal(m.flow.currentKbps, 4500);
  m.flow.packet(m.frame(5)); assert.equal(m.submitted.length, 5);
  m.flow.packet(m.frame(6, true)); assert.equal(m.submitted.length, 6);
  assert.equal(m.flow.needsIdr, false);
  assert.deepEqual(m.calls.filter(call => 'bitrate' in call).map(call => call.bitrate), [900, 9000, 4500]);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('safe allocation fluctuations keep sending without reinitializing AMF or requesting more IDRs', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.feedback(1, 1000000); await m.flow.rateWork; m.flow.packet(m.frame(1, true));
  const allocations = [1010000, 990000, 950000, 900000, 1050000];
  for (const [index, bitrate] of allocations.entries()) {
    m.feedback(index + 2, bitrate);
    assert.equal(m.flow.currentKbps, 900); assert.equal(m.flow.desiredKbps, 900);
    assert.ok(m.flow.currentKbps * 1000 <= bitrate);
    assert.equal(m.flow.needsIdr, false);
    m.flow.packet(m.frame(index + 2));
  }
  assert.equal(m.submitted.length, 6);
  assert.deepEqual(m.calls, [{ bitrate: 900 }]);
  m.tick(3100); m.feedback(7, 1250000); await m.flow.rateWork;
  assert.equal(m.flow.currentKbps, 1100);
  assert.deepEqual(m.calls.filter(call => 'bitrate' in call).map(call => call.bitrate), [900, 1100]);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('feedback during an update uses the pending setting and promptly applies the latest reduction', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  const acknowledgements = [];
  m.flow.host.setBitrate = value => {
    m.calls.push({ bitrate: value });
    return new Promise(resolve => acknowledgements.push(() =>
      resolve({ bitrateKbps: value, settingsAccepted: true, hardwareApplicationConfirmed: false })));
  };
  m.feedback(1, 10000000); const first = m.flow.rateWork;
  assert.equal(m.flow.applyingKbps, 9000);
  m.feedback(2, 12000000); assert.equal(m.flow.desiredKbps, 10800);
  m.feedback(3, 9500000); assert.equal(m.flow.desiredKbps, 9000);
  m.feedback(4, 8000000); assert.equal(m.flow.desiredKbps, 7200);
  m.flow.packet(m.frame(1, true)); assert.equal(m.submitted.length, 1);
  acknowledgements[0](); await first;
  assert.equal(m.flow.applyingKbps, 7200);
  assert.equal(m.flow.rateTimer, undefined);
  m.feedback(5, 7900000); assert.equal(m.flow.desiredKbps, 7200);
  const second = m.flow.rateWork; acknowledgements[1](); await second;
  assert.equal(m.flow.currentKbps, 7200); assert.equal(m.flow.applyingKbps, null);
  assert.deepEqual(m.calls.filter(call => 'bitrate' in call).map(call => call.bitrate), [9000, 7200]);
  m.flow.packet(m.frame(2, true)); assert.equal(m.submitted.length, 2);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('hardware configuration stays representable without starving a positive RTC allocation', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.feedback(1, 50000); await m.flow.rateWork;
  assert.equal(m.flow.currentKbps, 50); assert.equal(m.flow.paused, false);
  m.flow.packet(m.frame(1, true));
  m.feedback(2, 46433);
  assert.equal(m.flow.paused, false); assert.equal(m.flow.snapshot().feedback.bitrateBps, 46433);
  assert.equal(m.flow.snapshot().feedback.hostSelectedKbps, 50);
  m.flow.packet(m.frame(2)); assert.equal(m.submitted.length, 2);
  m.feedback(3, 50000); m.flow.packet(m.frame(3, true));
  assert.equal(m.submitted.length, 3);
  assert.deepEqual(m.calls.filter(call => 'bitrate' in call).map(call => call.bitrate), [50]);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('a zero RTC allocation pauses even without an explicit pause flag', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.feedback(1, 0);
  assert.equal(m.flow.paused, true);
  m.flow.packet(m.frame(1, true));
  assert.equal(m.submitted.length, 0);
  assert.equal(m.flow.snapshot().feedback.hostSelectedKbps, null);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('a positive allocation below startup bitrate continues real media so congestion feedback can recover', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  for (const [index, [allocation, setting]] of [[143088, 100], [50000, 50], [900000, 800]].entries()) {
    m.tick(2000 + index * 1500);
    m.feedback(index + 1, allocation);
    await m.flow.rateWork;
    assert.equal(m.flow.currentKbps, setting);
    assert.ok(setting * 1000 <= allocation);
    assert.equal(m.flow.paused, false);
    m.flow.packet(m.frame(index + 1, index === 0));
    assert.equal(m.submitted.length, index + 1);
  }
  await m.flow.close(); assert.deepEqual(m.errors, []);
});

test('Watch pause suspends the real IDR deadline and pending feedback cancellation is not hardware failure', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.flow.packet(m.frame(1));
  m.flow.setDemand(false);
  m.tick(5000);
  m.flow.setDemand(true); m.flow.packet(m.frame(2));
  assert.equal(m.submitted.length, 0);
  m.flow.packet(m.frame(3, true)); assert.equal(m.submitted.length, 1);
  m.flow.rateWork = Promise.reject(new DOMException('Owner stopped feedback.', 'AbortError'));
  await m.flow.close(); assert.equal(m.flow.snapshot().cancelledFeedbackRequests, 1);
  const n = model();
  n.flow.rateWork = Promise.reject(new Error('Native encoder failure'));
  await assert.rejects(n.flow.close(), /did not retire cleanly/);
});

test('sixteen native copy credits backpressure without dropping or recounting the next compressed AU', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  const retire = frameId => ({ target: 7, data: { sourceId: 7, frameId,
    nativeCopyRetired: true, networkDeliveryConfirmed: false } });
  for (let id = 1; id <= 16; id++) m.flow.packet(m.frame(id, id === 1));
  assert.equal(m.flow.packet(m.frame(17)), false);
  assert.equal(m.flow.snapshot().observed, 16); assert.equal(m.submitted.length, 16);
  m.flow.released(retire(3));
  assert.equal(m.flow.packet(m.frame(17)), undefined); assert.equal(m.submitted.length, 17);
  assert.equal(m.flow.snapshot().retainedNativeCopies, 16);
  assert.throws(() => m.flow.released(retire(3)), /Unknown or duplicate/);
  assert.throws(() => m.flow.released({ ...retire(1), target: 8 }));
  await m.flow.close();
  for (const id of m.flow.inFlight) m.flow.released(retire(id));
  assert.equal(m.flow.snapshot().retainedNativeCopies, 0);
  assert.equal(m.flow.snapshot().nativeCopiesReleased, 17);
});

test('only native QUEUE_FULL with outstanding ownership is retryable; other native failures stay explicit', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.flow.packet(m.frame(1, true));
  m.flow.engine.submitEncodedFrame = () => { throw Object.assign(new Error('copy budget'), { code: 'ERR_RTC_ENCODED_INPUT', status: 3 }); };
  assert.equal(m.flow.packet(m.frame(2)), false);
  assert.equal(m.flow.snapshot().observed, 1);
  m.flow.engine.submitEncodedFrame = () => { throw Object.assign(new Error('old timestamp'), { code: 'ERR_RTC_ENCODED_INPUT', status: 6 }); };
  assert.throws(() => m.flow.packet(m.frame(2)), /old timestamp/);
  await m.flow.close();
});

test('Watch resume can bootstrap a new codec from a real IDR after the previous encoder closes', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.flow.packet(m.frame(1, true)); m.flow.setDemand(false);
  m.flow.feedback({ target: 7, data: { sourceId: 7, sequence: 1, kind: 'encoder-closed',
    bitrateBps: 0, paused: false, requestedFps: 0, fpsApplied: null, bitrateCeilingBps: 80000000, keyframeConfirmed: false } });
  m.flow.setDemand(true);
  m.flow.packet(m.frame(2)); assert.equal(m.submitted.length, 1);
  m.flow.packet(m.frame(3, true)); assert.equal(m.submitted.length, 2);
  assert.equal(m.flow.paused, false);
  await m.flow.close();
});

for (const reason of ['rtc-unconsumed', 'clock-sample-uncertain']) {
test(`${reason}: native dependency recovery consumes no rejected copy and waits for a real new IDR`, async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.flow.packet(m.frame(1, true));
  m.flow.feedback({ target: 7, data: { sourceId: 7, sequence: 1, kind: 'recovery',
    reason, frameId: 1, generation: 2, mode: 'next-real-idr',
    maximumWaitMs: 1500, keyframeConfirmed: false } });
  m.flow.packet(m.frame(2)); assert.equal(m.submitted.length, 1);
  m.flow.packet(m.frame(3, true)); assert.equal(m.submitted.length, 2);
  const submit = m.flow.engine.submitEncodedFrame;
  m.flow.engine.submitEncodedFrame = () => {
    throw Object.assign(new Error('IDR needed before feedback delivery'), { code: 'ERR_RTC_ENCODED_RECOVERY', status: 8 });
  };
  m.flow.packet(m.frame(4));
  assert.equal(m.flow.snapshot().nativeRecoveryRejections, 1);
  assert.equal(m.flow.snapshot().retainedNativeCopies, 2);
  m.flow.engine.submitEncodedFrame = submit;
  m.flow.packet(m.frame(5)); assert.equal(m.submitted.length, 2);
  m.flow.packet(m.frame(6, true)); assert.equal(m.submitted.length, 3);
  assert.equal(m.flow.snapshot().nativeRecoveryRequests, 1);
  assert.equal(m.flow.snapshot().recovery.reason, reason);
  await m.flow.close(); assert.deepEqual(m.errors, []);
});
}

test('persistent recovery rejection is bounded and unknown errors never become recovery success', async () => {
  const m = model(); m.flow.setConnected(true); m.flow.setDemand(true);
  m.flow.engine.submitEncodedFrame = () => {
    throw Object.assign(new Error('stale IDR'), { code: 'ERR_RTC_ENCODED_RECOVERY', status: 8 });
  };
  for (let id = 1; id <= m.bound; id++) m.flow.packet(m.frame(id, true));
  assert.equal(m.flow.snapshot().nativeRecoveryRejections, m.bound);
  assert.throws(() => m.flow.packet(m.frame(m.bound + 1, true)), /fresh IDR within the live recovery bound/);
  m.flow.engine.submitEncodedFrame = () => {
    throw Object.assign(new Error('terminal recovery failure'), { code: 'ERR_RTC_ENCODED_RECOVERY', status: 7 });
  };
  assert.throws(() => m.flow.packet(m.frame(3, true)), /terminal recovery/);
  assert.equal(m.flow.snapshot().retainedNativeCopies, 0);
  await m.flow.close();
});
