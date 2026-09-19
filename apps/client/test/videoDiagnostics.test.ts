import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VideoDiagnosticsSampler,
  VideoPlaybackInput,
  VideoRtpDiagnostics,
  VideoSendLimits,
  VideoStatsReport,
} from '../src/renderer/core/webrtc/videoDiagnostics';

type StatEntry = [string, Record<string, unknown>];

function stats(...entries: StatEntry[]): VideoStatsReport {
  return new Map<string, unknown>(entries);
}

function approx(actual: number | null, expected: number, epsilon = 1e-9): void {
  assert.ok(actual !== null, `expected ${expected}, received null`);
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${expected}, received ${actual}`);
}

function outbound(
  timestamp: number,
  overrides: Record<string, unknown> = {},
  extras: StatEntry[] = []
): VideoStatsReport {
  const entries: StatEntry[] = [
    ['codec-video', { type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' }],
    ['source-video', { type: 'media-source', kind: 'video', timestamp, frames: 0, width: 1920, height: 1080 }],
    ['pair-video', { type: 'candidate-pair', currentRoundTripTime: 0.05, availableOutgoingBitrate: 8_000_000 }],
    ['transport-video', { type: 'transport', selectedCandidatePairId: 'pair-video' }],
    ['video', {
      id: 'video',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp,
      codecId: 'codec-video',
      mediaSourceId: 'source-video',
      transportId: 'transport-video',
      bytesSent: 0,
      framesEncoded: 0,
      framesSent: 0,
      totalEncodeTime: 0,
      keyFramesEncoded: 0,
      frameWidth: 1280,
      frameHeight: 720,
      targetBitrate: 0,
      ...overrides,
    }],
    ...extras,
  ];
  return stats(...entries);
}

function inbound(
  timestamp: number,
  overrides: Record<string, unknown> = {},
  extras: StatEntry[] = []
): VideoStatsReport {
  const entries: StatEntry[] = [
    ['codec-video', { type: 'codec', mimeType: 'video/VP9' }],
    ['pair-video', { type: 'candidate-pair', currentRoundTripTime: 0.07, availableOutgoingBitrate: 9_000_000 }],
    ['transport-video', { type: 'transport', selectedCandidatePairId: 'pair-video' }],
    ['video', {
      id: 'video',
      type: 'inbound-rtp',
      kind: 'video',
      timestamp,
      codecId: 'codec-video',
      transportId: 'transport-video',
      bytesReceived: 0,
      framesDecoded: 0,
      framesReceived: 0,
      totalDecodeTime: 0,
      packetsLost: 0,
      packetsReceived: 0,
      jitter: 0,
      jitterBufferDelay: 0,
      jitterBufferEmittedCount: 0,
      frameWidth: 1280,
      frameHeight: 720,
      ...overrides,
    }],
    ...extras,
  ];
  return stats(...entries);
}

function playback(input: Partial<VideoPlaybackInput> = {}): VideoPlaybackInput {
  return {
    timestampMs: 1000,
    totalFrames: 0,
    droppedFrames: 0,
    sourceKey: 'source-a',
    width: 640,
    height: 360,
    paused: false,
    ...input,
  };
}

function byId(items: VideoRtpDiagnostics[], id: string): VideoRtpDiagnostics {
  const item = items.find(entry => entry.id === id);
  assert.ok(item, `missing stream ${id}`);
  return item;
}

test('outbound stats use exact links, correct units and per-rid caps', () => {
  const sampler = new VideoDiagnosticsSampler();
  const target = {};
  const limits: VideoSendLimits = {
    encodings: [
      { rid: 'q', maxBitrate: 1_000_000, maxFramerate: 15 },
      { rid: 'f', maxBitrate: 4_000_000, maxFramerate: 30 },
    ],
    degradationPreference: 'maintain-framerate',
  };

  sampler.sampleOutbound(target, outbound(1000, {
    rid: 'f',
    bytesSent: 100_000,
    framesEncoded: 100,
    framesSent: 90,
    totalEncodeTime: 1,
    keyFramesEncoded: 2,
    targetBitrate: 5_000_000,
    encoderImplementation: 'SoftwareEncoder',
    powerEfficientEncoder: false,
    qualityLimitationReason: 'cpu',
    frameWidth: 1920,
    frameHeight: 1080,
  }, [
    ['source-video', { type: 'media-source', kind: 'video', timestamp: 1000, frames: 100, width: 2560, height: 1440 }],
    ['pair-video', { type: 'candidate-pair', currentRoundTripTime: 0.05, availableOutgoingBitrate: 8_000_000 }],
    ['codec-video', { type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' }],
  ]), limits, 'track-a');

  const sample = sampler.sampleOutbound(target, outbound(2000, {
    rid: 'f',
    bytesSent: 300_000,
    framesEncoded: 160,
    framesSent: 150,
    totalEncodeTime: 1.24,
    keyFramesEncoded: 3,
    targetBitrate: 5_000_000,
    encoderImplementation: 'SoftwareEncoder',
    powerEfficientEncoder: false,
    qualityLimitationReason: 'cpu',
    frameWidth: 1920,
    frameHeight: 1080,
  }, [
    ['source-video', { type: 'media-source', kind: 'video', timestamp: 2000, frames: 160, width: 2560, height: 1440 }],
    ['pair-video', { type: 'candidate-pair', currentRoundTripTime: 0.05, availableOutgoingBitrate: 8_000_000 }],
    ['codec-video', { type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' }],
  ]), limits, 'track-a')[0];

  assert.ok(sample);
  assert.equal(sample.direction, 'outbound');
  assert.equal(sample.timestampMs, 2000);
  assert.equal(sample.intervalMs, 1000);
  assert.equal(sample.codec, 'H264');
  assert.equal(sample.codecParameters, 'profile-level-id=42e01f');
  assert.equal(sample.encoderImplementation, 'SoftwareEncoder');
  assert.equal(sample.powerEfficientEncoder, false);
  assert.equal(sample.qualityLimitationReason, 'cpu');
  assert.equal(sample.width, 1920);
  assert.equal(sample.height, 1080);
  assert.equal(sample.sourceWidth, 2560);
  assert.equal(sample.sourceHeight, 1440);
  assert.equal(sample.targetBitrateKbps, 5000);
  assert.equal(sample.maxBitrateKbps, 4000);
  assert.equal(sample.maxFramerate, 30);
  assert.equal(sample.degradationPreference, 'maintain-framerate');
  assert.equal(sample.roundTripTimeMs, 50);
  assert.equal(sample.availableOutgoingBitrateKbps, 8000);
  assert.equal(sample.framesEncoded, 160);
  assert.equal(sample.framesSent, 150);
  assert.equal(sample.keyFramesEncoded, 3);
  approx(sample.fps, 60);
  approx(sample.sentFps, 60);
  approx(sample.bitrateKbps, 1600);
  approx(sample.encodeTimeMs, 4);
  approx(sample.keyFramesPerSecond, 1);
  approx(sample.sourceFps, 60);
});

test('first observations stay null while valid unchanged counters yield actual zero rates', () => {
  const sampler = new VideoDiagnosticsSampler();
  const target = {};
  const first = sampler.sampleOutbound(target, outbound(1000, {
    bytesSent: 10_000,
    framesEncoded: 25,
    framesSent: 25,
    totalEncodeTime: 1.5,
    keyFramesEncoded: 2,
  }, [
    ['source-video', { type: 'media-source', kind: 'video', timestamp: 1000, frames: 25, width: 1280, height: 720 }],
  ]), undefined, 'track-a')[0];
  const second = sampler.sampleOutbound(target, outbound(2000, {
    bytesSent: 10_000,
    framesEncoded: 25,
    framesSent: 25,
    totalEncodeTime: 1.5,
    keyFramesEncoded: 2,
  }, [
    ['source-video', { type: 'media-source', kind: 'video', timestamp: 2000, frames: 25, width: 1280, height: 720 }],
  ]), undefined, 'track-a')[0];

  assert.ok(first && second);
  assert.equal(first.intervalMs, null);
  assert.equal(first.fps, null);
  assert.equal(first.sentFps, null);
  assert.equal(first.bitrateKbps, null);
  assert.equal(first.encodeTimeMs, null);
  assert.equal(first.keyFramesPerSecond, null);
  assert.equal(first.sourceFps, null);
  assert.equal(second.intervalMs, 1000);
  assert.equal(second.fps, 0);
  assert.equal(second.sentFps, 0);
  assert.equal(second.bitrateKbps, 0);
  assert.equal(second.encodeTimeMs, null);
  assert.equal(second.keyFramesPerSecond, 0);
  assert.equal(second.sourceFps, 0);
});

test('same stats ids remain isolated per target regardless of sampling order', () => {
  const sampler = new VideoDiagnosticsSampler();
  const targetA = {};
  const targetB = {};

  sampler.sampleOutbound(targetA, outbound(1000, { id: 'shared', bytesSent: 0, framesEncoded: 0 }), undefined, 'track');
  sampler.sampleOutbound(targetB, outbound(1000, { id: 'shared', bytesSent: 1000, framesEncoded: 10 }), undefined, 'track');

  const sampleB = sampler.sampleOutbound(targetB, outbound(2000, { id: 'shared', bytesSent: 31_000, framesEncoded: 40 }), undefined, 'track')[0];
  const sampleA = sampler.sampleOutbound(targetA, outbound(2000, { id: 'shared', bytesSent: 120_000, framesEncoded: 60 }), undefined, 'track')[0];

  assert.ok(sampleA && sampleB);
  approx(sampleA.fps, 60);
  approx(sampleA.bitrateKbps, 960);
  approx(sampleB.fps, 30);
  approx(sampleB.bitrateKbps, 240);
});

test('multiple outbound RTP streams stay separate and match their own rid limits', () => {
  const sampler = new VideoDiagnosticsSampler();
  const target = {};
  const limits: VideoSendLimits = {
    encodings: [
      { rid: 'l', maxBitrate: 1_000_000, maxFramerate: 15 },
      { rid: 'h', maxBitrate: 5_000_000, maxFramerate: 60 },
    ],
    degradationPreference: 'maintain-resolution',
  };
  const first = stats(
    ['codec', { type: 'codec', mimeType: 'video/VP8' }],
    ['pair', { type: 'candidate-pair', currentRoundTripTime: 0.02, availableOutgoingBitrate: 9_000_000 }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['high', { id: 'high', type: 'outbound-rtp', kind: 'video', timestamp: 1000, codecId: 'codec', transportId: 'transport', rid: 'h', bytesSent: 0, framesEncoded: 0 }],
    ['low', { id: 'low', type: 'outbound-rtp', kind: 'video', timestamp: 1000, codecId: 'codec', transportId: 'transport', rid: 'l', bytesSent: 0, framesEncoded: 0 }],
  );
  const second = stats(
    ['codec', { type: 'codec', mimeType: 'video/VP8' }],
    ['pair', { type: 'candidate-pair', currentRoundTripTime: 0.02, availableOutgoingBitrate: 9_000_000 }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['high', { id: 'high', type: 'outbound-rtp', kind: 'video', timestamp: 2000, codecId: 'codec', transportId: 'transport', rid: 'h', bytesSent: 125_000, framesEncoded: 60 }],
    ['low', { id: 'low', type: 'outbound-rtp', kind: 'video', timestamp: 2000, codecId: 'codec', transportId: 'transport', rid: 'l', bytesSent: 31_250, framesEncoded: 15 }],
  );

  sampler.sampleOutbound(target, first, limits, 'track-a');
  const result = sampler.sampleOutbound(target, second, limits, 'track-a');
  const high = byId(result, 'high');
  const low = byId(result, 'low');

  assert.equal(result.length, 2);
  assert.equal(high.codec, 'VP8');
  assert.equal(low.codec, 'VP8');
  assert.equal(high.maxBitrateKbps, 5000);
  assert.equal(high.maxFramerate, 60);
  assert.equal(low.maxBitrateKbps, 1000);
  assert.equal(low.maxFramerate, 15);
  approx(high.fps, 60);
  approx(low.fps, 15);
  approx(high.bitrateKbps, 1000);
  approx(low.bitrateKbps, 250);
});

test('source changes and counter resets reset derived history even when ids stay the same', () => {
  const sampler = new VideoDiagnosticsSampler();
  const target = {};

  sampler.sampleOutbound(target, outbound(1000, {
    bytesSent: 100_000,
    framesEncoded: 100,
    framesSent: 100,
    totalEncodeTime: 1,
  }, [
    ['source-video', { type: 'media-source', kind: 'video', timestamp: 1000, frames: 100, width: 1920, height: 1080 }],
  ]), undefined, 'track-a');

  const replacement = sampler.sampleOutbound(target, outbound(2000, {
    bytesSent: 200_000,
    framesEncoded: 180,
    framesSent: 180,
    totalEncodeTime: 2,
  }, [
    ['source-video', { type: 'media-source', kind: 'video', timestamp: 2000, frames: 180, width: 1920, height: 1080 }],
  ]), undefined, 'track-b')[0];

  const reset = sampler.sampleOutbound(target, outbound(3000, {
    bytesSent: 5_000,
    framesEncoded: 20,
    framesSent: 20,
    totalEncodeTime: 0.1,
  }, [
    ['source-video', { type: 'media-source', kind: 'video', timestamp: 3000, frames: 20, width: 1920, height: 1080 }],
  ]), undefined, 'track-b')[0];

  assert.ok(replacement && reset);
  assert.equal(replacement.intervalMs, null);
  assert.equal(replacement.fps, null);
  assert.equal(replacement.sentFps, null);
  assert.equal(replacement.bitrateKbps, null);
  assert.equal(replacement.encodeTimeMs, null);
  assert.equal(replacement.sourceFps, null);
  assert.equal(reset.intervalMs, 1000);
  assert.equal(reset.fps, null);
  assert.equal(reset.sentFps, null);
  assert.equal(reset.bitrateKbps, null);
  assert.equal(reset.encodeTimeMs, null);
  assert.equal(reset.sourceFps, null);
});

test('inactive outbound streams are skipped while active absent streams can still report real zero rates', () => {
  const sampler = new VideoDiagnosticsSampler();
  const target = {};

  sampler.sampleOutbound(target, stats(
    ['codec-live', { type: 'codec', mimeType: 'video/H264' }],
    ['codec-old', { type: 'codec', mimeType: 'video/VP8' }],
    ['pair', { type: 'candidate-pair', currentRoundTripTime: 0.03, availableOutgoingBitrate: 4_000_000 }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['live', {
      id: 'live',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 1000,
      codecId: 'codec-live',
      transportId: 'transport',
      bytesSent: 10_000,
      framesEncoded: 10,
    }],
    ['inactive', {
      id: 'inactive',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 1000,
      codecId: 'codec-old',
      transportId: 'transport',
      active: false,
      bytesSent: 100_000,
      framesEncoded: 100,
    }],
  ), undefined, 'track-a');

  const result = sampler.sampleOutbound(target, stats(
    ['codec-live', { type: 'codec', mimeType: 'video/H264' }],
    ['codec-old', { type: 'codec', mimeType: 'video/VP8' }],
    ['pair', { type: 'candidate-pair', currentRoundTripTime: 0.03, availableOutgoingBitrate: 4_000_000 }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['live', {
      id: 'live',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 2000,
      codecId: 'codec-live',
      transportId: 'transport',
      bytesSent: 10_000,
      framesEncoded: 10,
    }],
    ['inactive', {
      id: 'inactive',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 2000,
      codecId: 'codec-old',
      transportId: 'transport',
      active: false,
      bytesSent: 200_000,
      framesEncoded: 200,
    }],
  ), undefined, 'track-a');

  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, 'live');
  assert.equal(result[0]?.fps, 0);
  assert.equal(result[0]?.bitrateKbps, 0);
});

test('codec changes reset the baseline for a reused stats id', () => {
  const sampler = new VideoDiagnosticsSampler();
  const target = {};

  sampler.sampleOutbound(target, stats(
    ['codec-a', { type: 'codec', mimeType: 'video/H264' }],
    ['codec-b', { type: 'codec', mimeType: 'video/VP9' }],
    ['pair', { type: 'candidate-pair', currentRoundTripTime: 0.05, availableOutgoingBitrate: 6_000_000 }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['video', {
      id: 'video',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 1000,
      codecId: 'codec-a',
      transportId: 'transport',
      bytesSent: 100_000,
      framesEncoded: 100,
      totalEncodeTime: 1,
    }],
  ), undefined, 'track-a');

  const switched = sampler.sampleOutbound(target, stats(
    ['codec-a', { type: 'codec', mimeType: 'video/H264' }],
    ['codec-b', { type: 'codec', mimeType: 'video/VP9' }],
    ['pair', { type: 'candidate-pair', currentRoundTripTime: 0.05, availableOutgoingBitrate: 6_000_000 }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['video', {
      id: 'video',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 2000,
      codecId: 'codec-b',
      transportId: 'transport',
      bytesSent: 180_000,
      framesEncoded: 150,
      totalEncodeTime: 1.3,
    }],
  ), undefined, 'track-a')[0];

  const stabilized = sampler.sampleOutbound(target, stats(
    ['codec-b', { type: 'codec', mimeType: 'video/VP9' }],
    ['pair', { type: 'candidate-pair', currentRoundTripTime: 0.05, availableOutgoingBitrate: 6_000_000 }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['video', {
      id: 'video',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 3000,
      codecId: 'codec-b',
      transportId: 'transport',
      bytesSent: 260_000,
      framesEncoded: 190,
      totalEncodeTime: 1.5,
    }],
  ), undefined, 'track-a')[0];

  assert.ok(switched && stabilized);
  assert.equal(switched.codec, 'VP9');
  assert.equal(switched.intervalMs, null);
  assert.equal(switched.fps, null);
  assert.equal(switched.bitrateKbps, null);
  assert.equal(switched.encodeTimeMs, null);
  assert.equal(stabilized.codec, 'VP9');
  assert.equal(stabilized.intervalMs, 1000);
  approx(stabilized.fps, 40);
  approx(stabilized.bitrateKbps, 640);
  approx(stabilized.encodeTimeMs, 5);
});

test('linkage stays exact and audio, repair and remote reports are excluded', () => {
  const sampler = new VideoDiagnosticsSampler();
  const target = {};
  const reports = stats(
    ['codec-wrong', { type: 'codec', mimeType: 'video/VP9' }],
    ['codec-good', { type: 'codec', mimeType: 'video/AV1' }],
    ['codec-repair', { type: 'codec', mimeType: 'video/rtx' }],
    ['codec-audio', { type: 'codec', mimeType: 'audio/opus' }],
    ['source-wrong', { type: 'media-source', kind: 'video', timestamp: 1000, framesPerSecond: 999, width: 800, height: 600 }],
    ['source-good', { type: 'media-source', kind: 'video', timestamp: 1000, framesPerSecond: 30, width: 1920, height: 1080 }],
    ['pair-wrong', { type: 'candidate-pair', currentRoundTripTime: 0.2, availableOutgoingBitrate: 1_111_000 }],
    ['pair-good', { type: 'candidate-pair', currentRoundTripTime: 0.04, availableOutgoingBitrate: 7_000_000 }],
    ['transport-wrong', { type: 'transport', selectedCandidatePairId: 'pair-wrong' }],
    ['transport-good', { type: 'transport', selectedCandidatePairId: 'pair-good' }],
    ['repair', { id: 'repair', type: 'outbound-rtp', kind: 'video', timestamp: 1000, codecId: 'codec-repair' }],
    ['audio', { id: 'audio', type: 'outbound-rtp', kind: 'audio', timestamp: 1000, codecId: 'codec-audio' }],
    ['remote', { id: 'remote', type: 'remote-inbound-rtp', kind: 'video', timestamp: 1000, codecId: 'codec-good' }],
    ['legacy', { id: 'legacy', type: 'outbound-rtp', mediaType: 'video', timestamp: 1000, transportId: 'transport-good' }],
    ['good', {
      id: 'good',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 1000,
      codecId: 'codec-good',
      mediaSourceId: 'source-good',
      transportId: 'transport-good',
    }],
  );

  const result = sampler.sampleOutbound(target, reports, {
    encodings: [{ rid: 'h', maxBitrate: 2_000_000, maxFramerate: 30 }, { rid: 'l', maxBitrate: 500_000, maxFramerate: 15 }],
    degradationPreference: 'balanced',
  }, 'track-a');
  const good = byId(result, 'good');
  const legacy = byId(result, 'legacy');

  assert.equal(result.length, 2);
  assert.equal(good.codec, 'AV1');
  assert.equal(good.roundTripTimeMs, 40);
  assert.equal(good.availableOutgoingBitrateKbps, 7000);
  assert.equal(good.sourceFps, 30);
  assert.equal(good.sourceWidth, 1920);
  assert.equal(good.sourceHeight, 1080);
  assert.equal(legacy.codec, null);
  assert.equal(legacy.roundTripTimeMs, 40);
  assert.equal(legacy.maxBitrateKbps, null);
  assert.equal(legacy.maxFramerate, null);
});

test('inbound stats derive fps, bitrate, decode time, jitter buffer and late loss recovery safely', () => {
  const sampler = new VideoDiagnosticsSampler();
  const target = {};

  sampler.sampleInbound(target, inbound(1000, {
    bytesReceived: 100_000,
    framesDecoded: 200,
    framesReceived: 205,
    totalDecodeTime: 1,
    packetsLost: 10,
    packetsReceived: 100,
    jitter: 0.005,
    jitterBufferDelay: 10,
    jitterBufferEmittedCount: 100,
    framesDropped: 2,
  }), 'track-a');

  const second = sampler.sampleInbound(target, inbound(2000, {
    bytesReceived: 250_000,
    framesDecoded: 260,
    framesReceived: 265,
    totalDecodeTime: 1.18,
    packetsLost: 12,
    packetsReceived: 160,
    jitter: 0.005,
    jitterBufferDelay: 16,
    jitterBufferEmittedCount: 160,
    framesDropped: 5,
  }), 'track-a')[0];

  const lateRecovery = sampler.sampleInbound(target, inbound(3000, {
    bytesReceived: 260_000,
    framesDecoded: 280,
    framesReceived: 285,
    totalDecodeTime: 1.24,
    packetsLost: 11,
    packetsReceived: 220,
    jitter: 0.006,
    jitterBufferDelay: 18,
    jitterBufferEmittedCount: 180,
    framesDropped: 6,
  }), 'track-a')[0];

  assert.ok(second && lateRecovery);
  assert.equal(second.codec, 'VP9');
  assert.equal(second.intervalMs, 1000);
  assert.equal(second.availableOutgoingBitrateKbps, null);
  assert.equal(second.roundTripTimeMs, 70);
  assert.equal(second.framesReceived, 265);
  assert.equal(second.framesDecoded, 260);
  assert.equal(second.framesDropped, 5);
  approx(second.fps, 60);
  approx(second.bitrateKbps, 1200);
  approx(second.decodeTimeMs, 3);
  approx(second.packetLossPct, (2 / 62) * 100);
  approx(second.jitterMs, 5);
  approx(second.jitterBufferMs, 100);
  assert.equal(lateRecovery.packetLossPct, null);
});

test('malformed or unsupported stats stay nullable without throwing', () => {
  const sampler = new VideoDiagnosticsSampler();
  const target = {};
  const result = sampler.sampleOutbound(target, stats(
    ['junk', { type: 'codec', mimeType: 42 }],
    ['ignored', { value: true }],
    ['video', {
      id: 'video',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 'bad',
      codecId: 'junk',
      qualityLimitationReason: 'mystery',
      powerEfficientEncoder: 'yes',
      frameWidth: -1,
      frameHeight: 0,
    }],
  ), undefined, 'track-a')[0];

  assert.ok(result);
  assert.equal(result.id, 'video');
  assert.equal(result.codec, null);
  assert.equal(result.codecParameters, null);
  assert.equal(result.timestampMs, null);
  assert.equal(result.intervalMs, null);
  assert.equal(result.fps, null);
  assert.equal(result.bitrateKbps, null);
  assert.equal(result.width, null);
  assert.equal(result.height, null);
  assert.equal(result.powerEfficientEncoder, null);
  assert.equal(result.qualityLimitationReason, null);
});

test('playback stats separate presented fps, dropped deltas, source changes and invalid counters', () => {
  const sampler = new VideoDiagnosticsSampler();
  const target = {};

  const first = sampler.samplePlayback(target, playback({
    timestampMs: 1000,
    totalFrames: 10,
    droppedFrames: 1,
    sourceKey: 'track-a',
  }));
  const second = sampler.samplePlayback(target, playback({
    timestampMs: 2000,
    totalFrames: 40,
    droppedFrames: 4,
    sourceKey: 'track-a',
  }));
  const third = sampler.samplePlayback(target, playback({
    timestampMs: 3000,
    totalFrames: 40,
    droppedFrames: 4,
    sourceKey: 'track-a',
    paused: true,
  }));
  const replacement = sampler.samplePlayback(target, playback({
    timestampMs: 4000,
    totalFrames: 5,
    droppedFrames: 0,
    sourceKey: 'track-b',
    width: 1280,
    height: 720,
  }));
  const invalid = sampler.samplePlayback(target, playback({
    timestampMs: 5000,
    totalFrames: 4,
    droppedFrames: 5,
    sourceKey: 'track-b',
    width: 0,
    height: 0,
  }));

  assert.equal(first.intervalMs, null);
  assert.equal(first.fps, null);
  assert.equal(first.droppedFramesDelta, null);
  assert.equal(first.totalFrames, 10);
  assert.equal(first.droppedFrames, 1);
  assert.equal(first.width, 640);
  assert.equal(first.height, 360);
  assert.equal(second.intervalMs, 1000);
  approx(second.fps, 27);
  assert.equal(second.droppedFramesDelta, 3);
  assert.equal(third.intervalMs, 1000);
  assert.equal(third.fps, 0);
  assert.equal(third.droppedFramesDelta, 0);
  assert.equal(third.paused, true);
  assert.equal(replacement.intervalMs, null);
  assert.equal(replacement.fps, null);
  assert.equal(replacement.droppedFramesDelta, null);
  assert.equal(replacement.totalFrames, 5);
  assert.equal(replacement.droppedFrames, 0);
  assert.equal(replacement.width, 1280);
  assert.equal(replacement.height, 720);
  assert.equal(invalid.fps, null);
  assert.equal(invalid.totalFrames, null);
  assert.equal(invalid.droppedFrames, null);
  assert.equal(invalid.droppedFramesDelta, null);
  assert.equal(invalid.width, null);
  assert.equal(invalid.height, null);
});

test('disappearing reports, retainTargets and clear forget old history', () => {
  const sampler = new VideoDiagnosticsSampler();
  const targetA = {};
  const targetB = {};

  sampler.sampleOutbound(targetA, outbound(1000, { bytesSent: 0, framesEncoded: 0 }), undefined, 'track-a');
  const derived = sampler.sampleOutbound(targetA, outbound(2000, { bytesSent: 62_500, framesEncoded: 30 }), undefined, 'track-a')[0];
  const gone = sampler.sampleOutbound(targetA, stats(), undefined, 'track-a');
  const reappeared = sampler.sampleOutbound(targetA, outbound(3000, { bytesSent: 125_000, framesEncoded: 60 }), undefined, 'track-a')[0];

  sampler.sampleOutbound(targetB, outbound(1000, { id: 'b', bytesSent: 0, framesEncoded: 0 }), undefined, 'track-b');
  sampler.sampleOutbound(targetB, outbound(2000, { id: 'b', bytesSent: 25_000, framesEncoded: 10 }), undefined, 'track-b');
  sampler.retainTargets(new Set<object>([targetB]));
  const forgottenByRetain = sampler.sampleOutbound(targetA, outbound(4000, { bytesSent: 187_500, framesEncoded: 90 }), undefined, 'track-a')[0];

  sampler.clear();
  const forgottenByClear = sampler.sampleOutbound(targetB, outbound(3000, { id: 'b', bytesSent: 50_000, framesEncoded: 20 }), undefined, 'track-b')[0];

  assert.ok(derived && reappeared && forgottenByRetain && forgottenByClear);
  approx(derived.fps, 30);
  assert.deepEqual(gone, []);
  assert.equal(reappeared.intervalMs, null);
  assert.equal(reappeared.fps, null);
  assert.equal(forgottenByRetain.intervalMs, null);
  assert.equal(forgottenByRetain.fps, null);
  assert.equal(forgottenByClear.intervalMs, null);
  assert.equal(forgottenByClear.fps, null);
});
