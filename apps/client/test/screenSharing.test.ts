import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CUSTOM_PROFILE, QUALITY_PRESETS, type QualityPresetType } from '@monky/shared';
import { applyMediaEncodingPolicy, getMediaEncodingPolicy } from '../src/renderer/core/webrtc/mediaEncodingPolicy';
import { updateRtpSenderParameters } from '../src/renderer/core/webrtc/rtpSenderParameters';
import './screenSubscriptions.test';

function parameters(): RTCRtpSendParameters {
  return {
    transactionId: 'negotiation',
    codecs: [{ mimeType: 'video/H264', clockRate: 90000, payloadType: 102 }],
    headerExtensions: [],
    rtcp: { cname: 'camera', reducedSize: true },
    encodings: [{ active: false, rid: 'camera', priority: 'high', scaleResolutionDownBy: 1 }],
  };
}

function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, resolve: () => release() };
}

test('all presets and custom use one per-publication audio/camera encoding policy', () => {
  const presets: QualityPresetType[] = ['ECONOMIC', 'NORMAL', 'HIGH', 'GAMING', 'QHD', 'UHD', 'UHD120', 'CUSTOM'];
  for (const preset of presets) {
    const profile = preset === 'CUSTOM' ? DEFAULT_CUSTOM_PROFILE : QUALITY_PRESETS[preset];
    const audio = getMediaEncodingPolicy('audio', preset, profile);
    const camera = getMediaEncodingPolicy('camera', preset, profile);
    assert.deepEqual(audio, { encoding: { maxBitrate: profile.audioBitrateKbps * 1000 } });
    assert.deepEqual(camera.encoding, { maxBitrate: profile.cameraBitrateKbps * 1000, maxFramerate: profile.cameraFps });
    assert.equal(camera.degradationPreference, ['GAMING', 'QHD', 'UHD', 'UHD120'].includes(preset)
      ? 'maintain-framerate' : 'maintain-resolution', 'Named 60+ FPS profiles hold frame rate; CUSTOM keeps resolution.');
  }
});

test('quality preserves paused state, negotiation metadata and auxiliary encodings', () => {
  const params = parameters();
  params.encodings.push({ active: false, rid: 'other', maxBitrate: 42 });
  const before = structuredClone(params);
  const policy = getMediaEncodingPolicy('camera', 'GAMING', QUALITY_PRESETS.GAMING);
  assert.equal(applyMediaEncodingPolicy(params, policy), true);
  assert.deepEqual(params, {
    ...before, degradationPreference: 'maintain-framerate',
    encodings: [{ ...before.encodings[0], ...policy.encoding }, before.encodings[1]],
  });
  const empty = { ...parameters(), encodings: [] };
  assert.equal(applyMediaEncodingPolicy(empty, policy), false);
  assert.deepEqual(empty.encodings, [], 'setParameters cannot invent a negotiated encoding');
});

test('quality is a snapshot even if the custom profile changes while an update is queued', () => {
  const profile = { ...DEFAULT_CUSTOM_PROFILE };
  const policy = getMediaEncodingPolicy('camera', 'CUSTOM', profile);
  profile.cameraBitrateKbps = 1;
  profile.cameraFps = 1;
  assert.equal(policy.encoding.maxBitrate, DEFAULT_CUSTOM_PROFILE.cameraBitrateKbps * 1000);
  assert.equal(policy.encoding.maxFramerate, DEFAULT_CUSTOM_PROFILE.cameraFps);
});

test('updates share a sender transaction queue without blocking other senders', async () => {
  let current = parameters();
  const events: string[] = [];
  const writing = gate();
  const release = gate();
  let writes = 0;
  const sender = {
    getParameters() { events.push('read'); return structuredClone(current); },
    async setParameters(value: RTCRtpSendParameters) {
      events.push(`write-${++writes}`);
      if (writes === 1) { writing.resolve(); await release.promise; }
      current = structuredClone(value);
    },
  };
  const activating = updateRtpSenderParameters(sender, params => {
    params.encodings[0].active = true;
    return true;
  });
  await writing.promise;
  const settingQuality = updateRtpSenderParameters(sender, params =>
    applyMediaEncodingPolicy(params, getMediaEncodingPolicy('camera', 'HIGH', QUALITY_PRESETS.HIGH)));
  let independentWritten = false;
  await updateRtpSenderParameters({
    getParameters: parameters,
    async setParameters() { independentWritten = true; },
  }, () => true);
  assert.equal(independentWritten, true);
  assert.equal(writes, 1);
  release.resolve();
  await Promise.all([activating, settingQuality]);
  assert.deepEqual(events, ['read', 'write-1', 'read', 'write-2']);
  assert.equal(current.encodings[0].active, true, 'the queued update reads the committed write instead of overwriting it');
  assert.equal(current.encodings[0].maxBitrate, QUALITY_PRESETS.HIGH.cameraBitrateKbps * 1000);
});

test('sender failures reach callers without poisoning later updates; cancellation skips writing', async () => {
  const failure = new Error('encoder unavailable');
  let writes = 0;
  const sender = {
    getParameters: parameters,
    async setParameters() { if (++writes === 1) throw failure; },
  };
  await assert.rejects(updateRtpSenderParameters(sender, () => true), error => error === failure);
  await updateRtpSenderParameters(sender, () => true);
  await updateRtpSenderParameters(sender, () => false);
  assert.equal(writes, 2);
});
