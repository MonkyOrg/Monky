import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CUSTOM_PROFILE, QUALITY_PRESETS, type QualityPresetType } from '@monky/shared';
import { applyMediaEncodingPolicy, getMediaEncodingPolicy } from '../src/renderer/core/webrtc/mediaEncodingPolicy';
import { updateRtpSenderParameters, type CodecSendParameters } from '../src/renderer/core/webrtc/rtpSenderParameters';
import { assertScreenCodecAccepted, ScreenCodecError } from '../src/renderer/core/webrtc/codecPreferences';
import './screenSubscriptions.test';

function parameters(): CodecSendParameters {
  return {
    transactionId: 'negotiation',
    codecs: [{ mimeType: 'video/H264', clockRate: 90000, payloadType: 102 }],
    headerExtensions: [],
    rtcp: { cname: 'screen', reducedSize: true },
    encodings: [{
      active: false, rid: 'screen', priority: 'high', scaleResolutionDownBy: 1,
      codec: { mimeType: 'video/H264', clockRate: 90000 },
    }],
  };
}

function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, resolve: () => release() };
}

test('all presets and custom use one per-publication audio/camera/screen encoding policy', () => {
  const presets: QualityPresetType[] = ['ECONOMIC', 'NORMAL', 'HIGH', 'GAMING', 'ULTRA', 'CUSTOM'];
  for (const preset of presets) {
    const profile = preset === 'CUSTOM' ? {
      ...DEFAULT_CUSTOM_PROFILE, screenFps: 120, screenBitrateKbps: 20000,
    } : QUALITY_PRESETS[preset];
    const audio = getMediaEncodingPolicy('audio', preset, profile);
    const camera = getMediaEncodingPolicy('camera', preset, profile);
    const screen = getMediaEncodingPolicy('screen', preset, profile);
    assert.deepEqual(audio, { encoding: { maxBitrate: profile.audioBitrateKbps * 1000 } });
    for (const [policy, bitrate, fps] of [
      [camera, profile.cameraBitrateKbps, profile.cameraFps],
      [screen, profile.screenBitrateKbps, profile.screenFps],
    ] as const) {
      assert.deepEqual(policy.encoding, { maxBitrate: bitrate * 1000, maxFramerate: fps });
      assert.equal(policy.degradationPreference, preset === 'GAMING' ? 'maintain-framerate' : 'maintain-resolution');
    }
  }
});

test('quality preserves codec pins, paused state, negotiation metadata and auxiliary encodings', () => {
  const params = parameters();
  params.encodings.push({ active: false, rid: 'other', maxBitrate: 42 });
  const before = structuredClone(params);
  const policy = getMediaEncodingPolicy('screen', 'GAMING', QUALITY_PRESETS.GAMING);
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
  const policy = getMediaEncodingPolicy('screen', 'CUSTOM', profile);
  profile.screenBitrateKbps = 1;
  profile.screenFps = 1;
  assert.equal(policy.encoding.maxBitrate, DEFAULT_CUSTOM_PROFILE.screenBitrateKbps * 1000);
  assert.equal(policy.encoding.maxFramerate, DEFAULT_CUSTOM_PROFILE.screenFps);
});

test('P2P and SFU reject alternate media codec families but accept their repair codecs', () => {
  assert.doesNotThrow(() => assertScreenCodecAccepted(['video/H264', 'video/rtx', 'video/red'], 'h264'));
  assert.doesNotThrow(() => assertScreenCodecAccepted(['video/H264', 'video/VP8'], 'auto'));
  for (const codecs of [[], ['video/rtx'], ['video/VP8'], ['video/H264', 'video/AV1']]) {
    assert.throws(() => assertScreenCodecAccepted(codecs, 'h264'), ScreenCodecError);
  }
});

test('codec and quality share a sender transaction queue without blocking other senders', async () => {
  let current = parameters();
  const events: string[] = [];
  const writing = gate();
  const release = gate();
  let writes = 0;
  const sender = {
    getParameters() { events.push('read'); return structuredClone(current); },
    async setParameters(value: CodecSendParameters) {
      events.push(`write-${++writes}`);
      if (writes === 1) { writing.resolve(); await release.promise; }
      current = structuredClone(value);
    },
  };
  const selectingCodec = updateRtpSenderParameters(sender, params => {
    params.encodings[0].active = true;
    return true;
  }, params => {
    assert.equal(params.encodings[0].active, true);
    events.push('verified');
  });
  await writing.promise;
  const settingQuality = updateRtpSenderParameters(sender, params =>
    applyMediaEncodingPolicy(params, getMediaEncodingPolicy('screen', 'HIGH', QUALITY_PRESETS.HIGH)));
  let independentWritten = false;
  await updateRtpSenderParameters({
    getParameters: parameters,
    async setParameters() { independentWritten = true; },
  }, () => true);
  assert.equal(independentWritten, true);
  assert.equal(writes, 1);
  release.resolve();
  await Promise.all([selectingCodec, settingQuality]);
  assert.deepEqual(events, ['read', 'write-1', 'read', 'verified', 'read', 'write-2']);
  assert.equal(current.encodings[0].active, true);
  assert.equal(current.encodings[0].codec?.mimeType, 'video/H264');
  assert.equal(current.encodings[0].maxBitrate, 3500000);
});

test('sender failures reach callers without poisoning later updates; cancellation skips writing', async () => {
  const failure = new Error('encoder unavailable');
  let writes = 0;
  let verifies = 0;
  const sender = {
    getParameters: parameters,
    async setParameters() { if (++writes === 1) throw failure; },
  };
  await assert.rejects(updateRtpSenderParameters(sender, () => true), error => error === failure);
  await updateRtpSenderParameters(sender, () => true);
  await updateRtpSenderParameters(sender, () => false, () => { verifies++; });
  assert.equal(writes, 2);
  assert.equal(verifies, 0);
});
