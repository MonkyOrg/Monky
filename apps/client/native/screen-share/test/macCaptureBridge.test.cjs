'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MacCaptureBridge, probeCaptureCapabilities, assertMacCaptureBridgeClosed } = require('../runtime/mac/captureBridge.cjs');
const { cloneCaptureTarget, captureEncoderProfile } = require('../runtime/captureBackend.cjs');

const target = { platform: 'darwin', kind: 'window', windowId: 123,
  expectedProcessId: 456, expectedProcessStartTimeUs: '1234567890' };
const video = { width: 1920, height: 1080, fps: 60, bitrateKbps: 15000 };
function fixture({ failure, retirementFailure, probe = {} } = {}) {
  const requests = [], packets = [], errors = [];
  const runtime = { kind: 'verified-screencapturekit-host', executable: '/fixture/owned-mac-host' };
  let owner;
  const dependencies = { hostFactory(executable, options) {
    assert.equal(executable, runtime.executable);
    owner = { exited: false, pending: new Map(), child: { pid: 321 }, mediaSequence: 0,
      async request(method, data) {
        requests.push({ method, data });
        if (method === 'resolve') return { value: { target: data.target } };
        if (method === 'media.probe') {
          if (failure) throw failure;
          return { value: { captureStarted: false, nativeClosed: true, hardwareExecutionObserved: null,
            sessionUsesHardware: data.video.mode === 'hardware', syntheticFrameEncoded: true,
            codec: data.video.codec, sequenceVerified: data.video.codec === 'av1',
            profileLevelId: data.video.codec === 'av1' ? null : '4d002a', ...probe } };
        }
        if (method === 'media.start') {
          const frame = { frameId: 1, timestampUs: 123, durationUs: 16666, keyframe: true,
            codec: data.video.codec, ntpTimeMs: -1, data: Buffer.from('fixture AU; not real encoded video') };
          options.onVideo(frame);
          owner.mediaSequence++;
          return { value: { captureStarted: true, source: data.target, video: data.video } };
        }
        if (method === 'media.bitrate') return { value: { bitrateKbps: data.bitrateKbps,
          settingsAccepted: true, hardwareApplicationConfirmed: false, fpsApplied: null } };
        if (method === 'media.keyframe') return { value: {
          mode: 'next-real-idr', keyframeConfirmed: false, maximumWaitMs: 1500 } };
        assert.fail(method);
      },
      async close() { if (retirementFailure) throw retirementFailure; owner.exited = true; },
      resumeVideo() {},
    };
    return owner;
  } };
  const options = { host: runtime, runtime: null, video, encoder: 'apple_vt_h264',
    bitrateCeilingKbps: 20000, onPacket: frame => { packets.push(frame); }, onError: error => errors.push(error) };
  return { options, dependencies, requests, packets, errors, get owner() { return owner; } };
}

test('VideoToolbox probe verifies a synthetic AU without claiming captured pixels or sustained throughput', async () => {
  for (const encoder of ['apple_vt_h264', 'apple_vt_h264_software']) {
    const f = fixture();
    const proof = await probeCaptureCapabilities({ ...f.options, encoder }, undefined, f.dependencies);
    assert.equal(proof.encoderId, encoder);
    assert.equal(proof.encoderInitialized, true);
    assert.equal(proof.hardwareSessionConfirmed, false);
    assert.equal(proof.hardwareQualified, false);
    assert.equal(proof.sourceCaptured, false);
    assert.equal(f.owner.exited, true);
    assert.deepEqual(f.requests.map(request => request.method), ['media.probe']);
  }
});

test('initialization without a real matching H264 access unit cannot enable a macOS encoder', async () => {
  for (const probe of [{ syntheticFrameEncoded: false }, { profileLevelId: '64003c' }]) {
    const f = fixture({ probe });
    await assert.rejects(probeCaptureCapabilities(f.options, undefined, f.dependencies));
    assert.equal(f.owner.exited, true);
  }
});
test('macOS AV1 requires a verified sequence and remains native software, not texture/hardware encoding', async () => {
  const f = fixture();
  f.options.encoder = 'monky_aom_av1';
  const proof = await probeCaptureCapabilities(f.options, undefined, f.dependencies);
  assert.equal(proof.codec, 'av1');
  assert.equal(proof.mode, 'software');
  assert.equal(proof.textureInput, false);
  assert.equal(proof.hardwareSessionConfirmed, false);
  assert.equal(proof.probe, 'libaom-session');
  const bridge = new MacCaptureBridge(f.options, f.dependencies);
  await bridge.prepare(target);
  const started = await bridge.start(target);
  assert.equal(started.codec, 'av1');
  assert.equal(started.hardwareSessionConfirmed, false);
  assert.equal(f.packets[0].codec, 'av1');
  await bridge.setBitrate(1000);
  await bridge.requestKeyFrame();
  assert.equal((await bridge.stop()).nativeClosed, true);
  for (const probe of [{ codec: 'h264' }, { sequenceVerified: false }, { sessionUsesHardware: true }]) {
    const invalid = fixture({ probe });
    await assert.rejects(probeCaptureCapabilities({ ...invalid.options, encoder: 'monky_aom_av1' },
      undefined, invalid.dependencies));
    assert.equal(invalid.owner.exited, true);
  }
});
test('macOS capture reuses the selected exact target, admits bytes unchanged, and confirms first-AU readiness', async () => {
  const f = fixture(), bridge = new MacCaptureBridge(f.options, f.dependencies);
  await bridge.prepare(target);
  assert.equal(bridge.getCapabilities().hardwareSessionConfirmed, false);
  assert.equal(f.packets.length, 0);
  assert.equal(bridge.child.pid, 321);
  await bridge.start(target);
  assert.equal(bridge.getCapabilities().hardwareSessionConfirmed, true);
  assert.equal(f.packets.length, 1);
  assert.deepEqual(f.requests.find(request => request.method === 'media.start').data.target, target);
  assert.equal((await bridge.setBitrate(1000)).hardwareApplicationConfirmed, false);
  assert.equal((await bridge.requestKeyFrame()).keyframeConfirmed, false);
  await assert.rejects(bridge.setBitrate(21000), /ceiling|profile/);
  const result = await bridge.stop();
  assert.equal(result.nativeClosed, true);
  assert.equal(result.forcedTermination, false);
  assert.equal(f.owner.exited, true);
});

test('macOS probe preserves driver failure and never fabricates retirement on failed close', async () => {
  const failure = Object.assign(new Error('Selected profile is unsupported.'), {
    code: 'ERR_MAC_VIDEO_PROPERTY', nativeStatus: -12900,
  });
  const f = fixture({ failure });
  await assert.rejects(probeCaptureCapabilities(f.options, undefined, f.dependencies), error => error === failure);
  assert.equal(f.owner.exited, true);
  const pending = fixture({ failure, retirementFailure: new Error('Still owned.') });
  await assert.rejects(probeCaptureCapabilities(pending.options, undefined, pending.dependencies), AggregateError);
  assert.equal(pending.owner.exited, false);
});

test('platform capture dispatch rejects Windows encoders for Apple sources without weakening Windows validation', () => {
  assert.equal(captureEncoderProfile('apple_vt_h264', target).codec, 'h264');
  assert.throws(() => captureEncoderProfile('obs_nvenc_h264_tex', target));
  assert.throws(() => captureEncoderProfile('apple_vt_h264', { kind: 'window' }));
  assert.throws(() => cloneCaptureTarget({ ...target, hwnd: 999 }));
  assert.throws(() => cloneCaptureTarget({ ...target, expectedProcessStartTimeUs: '0' }));
  const copy = cloneCaptureTarget(target);
  assert.notEqual(copy, target);
  assert.deepEqual(copy, target);
  assert.equal(Object.isFrozen(copy), true);
});

test('macOS retirement proof belongs to the original bridge, not a snapshot, method or fulfilled promise', async () => {
  const f = fixture(), bridge = new MacCaptureBridge(f.options, f.dependencies);
  await bridge.prepare(target);
  bridge.closed = true;
  bridge.snapshot = () => ({ nativeClosed: true, forcedTermination: false });
  bridge.assertClosed = () => {};
  assert.throws(() => assertMacCaptureBridgeClosed(bridge), /original macOS capture lease/);
  assert.throws(() => assertMacCaptureBridgeClosed({ closed: true, snapshot: bridge.snapshot }));
  const originalClose = f.owner.close;
  f.owner.close = async () => { f.owner.nativeClosed = true; };
  await bridge.stop();
  assertMacCaptureBridgeClosed(bridge);
  assert.equal(f.owner.exited, false, 'Releasing a lease must not terminate another owner of the helper.');
  await originalClose();
});
