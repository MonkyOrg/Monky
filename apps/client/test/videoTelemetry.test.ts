import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { VideoDiagnosticsSampler, VideoRtpDiagnostics } from '../src/renderer/core/webrtc/videoDiagnostics';
import { setLanguage, t } from '../src/renderer/i18n';
import { formatVideoTelemetry, serializeVideoTelemetry, VideoTelemetrySnapshot } from '../src/renderer/views/VideoTelemetry';

function stream(fps: number, bitrateKbps: number): VideoRtpDiagnostics {
  const sampler = new VideoDiagnosticsSampler();
  const target = {};
  const stats = (timestamp: number, frames: number, bytes: number) => new Map<string, unknown>([
    ['video', {
      id: 'video', type: 'outbound-rtp', kind: 'video', timestamp,
      framesEncoded: frames, bytesSent: bytes, codecId: 'codec',
      frameWidth: 1920, frameHeight: 1080, encoderImplementation: 'test-encoder',
      qualityLimitationReason: 'none', transportId: 'transport',
      trackIdentifier: 'private-track-identifier',
    }],
    ['codec', { type: 'codec', mimeType: 'video/H264' }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', {
      type: 'candidate-pair', currentRoundTripTime: 0.05,
      availableOutgoingBitrate: 10_000_000, address: '203.0.113.5',
    }],
  ]);
  sampler.sampleOutbound(target, stats(1000, 0, 0));
  const result = sampler.sampleOutbound(target, stats(2000, fps, bitrateKbps * 125))[0];
  assert.ok(result);
  return result;
}

function snapshot(): VideoTelemetrySnapshot {
  return {
    kind: 'sender',
    media: 'screen',
    transport: 'p2p',
    sampledAt: '2026-09-09T12:00:00.000Z',
    documentVisibility: 'visible',
    requested: { width: 1920, height: 1080, fps: 120, bitrateKbps: 20_000 },
    capture: { width: 1920, height: 1080, configuredFps: 120, contentHint: 'motion', readyState: 'live' },
    streams: [],
    playback: {
      fps: 30, width: 1920, height: 1080, totalFrames: 60,
      droppedFrames: 0, droppedFramesDelta: 0, intervalMs: 1000, paused: false,
    },
    readErrors: 0,
  };
}

test('local preview never substitutes configured or presented FPS for transmitted FPS', () => {
  setLanguage('en');
  const text = formatVideoTelemetry(snapshot(), 'complete');
  assert.match(text, /Local preview — no sending statistics/);
  assert.match(text, /RTP FPS: --/);
  assert.match(text, /RTP resolution: --/);
  assert.match(text, /Bitrate: -- kbps/);
  assert.match(text, /Requested: 1920x1080 \/ 120 FPS/);
  assert.match(text, /Capture \(configuration\): 1920x1080 \/ 120 FPS/);
  assert.match(text, /Player FPS: 30/);
});

test('multiple destinations show a FPS range and explicitly total only bitrate', () => {
  setLanguage('en');
  const value = snapshot();
  value.streams = [
    { endpoint: 1, data: stream(60, 3000) },
    { endpoint: 2, data: { ...stream(30, 1500), width: 1280, height: 720 } },
  ];
  const text = formatVideoTelemetry(value, 'simple');
  assert.match(text, /2 streams — minimum\/maximum values/);
  assert.match(text, /RTP FPS: 30-60/);
  assert.match(text, /RTP resolution: 1920x1080 \/ 1280x720/);
  assert.match(text, /Total sending bitrate: 4500 kbps/);
  assert.doesNotMatch(text, /RTP FPS: 90/);
  value.streams.reverse();
  assert.match(formatVideoTelemetry(value, 'simple'), /RTP FPS: 30-60/);
});

test('partially unavailable samples are not presented as a complete zero or total', () => {
  setLanguage('en');
  const value = snapshot();
  value.streams = [
    { endpoint: 1, data: stream(60, 3000) },
    { endpoint: 2, data: { ...stream(30, 1500), fps: null, bitrateKbps: null, codec: null } },
  ];
  const text = formatVideoTelemetry(value, 'simple');
  assert.match(text, /RTP FPS: 60 \/ --/);
  assert.match(text, /Codec: H264 \/ --/);
  assert.match(text, /Total sending bitrate: -- kbps/);
});

test('receiver metrics separate decoding, player presentation and average buffer wait', () => {
  setLanguage('en');
  const value = snapshot();
  value.kind = 'receiver';
  value.transport = 'sfu';
  value.requested = null;
  value.capture = null;
  value.streams = [{ endpoint: 1, data: {
    ...stream(60, 3000), direction: 'inbound', decodeTimeMs: 3,
    packetLossPct: 2, jitterMs: 5, jitterBufferMs: 80,
  } }];
  const text = formatVideoTelemetry(value, 'complete');
  assert.match(text, /SFU - Receiving/);
  assert.match(text, /RTP FPS: 60/);
  assert.match(text, /Player FPS: 30/);
  assert.match(text, /Average buffer wait: 80.0 ms/);
  assert.match(text, /Decode time per frame: 3.0 ms/);
  assert.doesNotMatch(text, /Requested:|Capture \(configuration\):|Encoder:/);
});

test('diagnostics and error indications follow the selected language', () => {
  setLanguage('pt-BR');
  const value = snapshot();
  value.readErrors = 1;
  value.streams = [{ endpoint: 1, data: {
    ...stream(30, 2000), qualityLimitationReason: 'bandwidth',
  } }];
  const text = formatVideoTelemetry(value, 'complete');
  assert.match(text, /P2P - Envio/);
  assert.match(text, /Limitação indicada: Banda/);
  assert.match(text, /FPS no player: 30/);
  assert.match(text, /Falhas ao ler estatísticas: 1/);
  setLanguage('en');
  assert.match(formatVideoTelemetry(value, 'complete'), /Reported limitation: Bandwidth/);
});

test('hidden-window presentation is identified without changing RTP metrics', () => {
  setLanguage('en');
  const value = snapshot();
  value.documentVisibility = 'hidden';
  value.streams = [{ endpoint: 1, data: stream(60, 3000) }];
  const text = formatVideoTelemetry(value, 'complete');
  assert.match(text, /RTP FPS: 60/);
  assert.match(text, /Player FPS: 30 \(window hidden\)/);
});

test('copy includes normalized per-stream snapshots and history, not raw RTC addresses or track identifiers', () => {
  setLanguage('en');
  const value = snapshot();
  value.streams = [{ endpoint: 1, data: stream(60, 3000) }];
  const history = [{ ...value, sampledAt: '2026-09-09T11:59:58.500Z' }, value];
  const serialized = serializeVideoTelemetry(value, 'Electron fixture', history);
  const parsed: unknown = JSON.parse(serialized);
  assert.deepEqual(parsed, {
    schemaVersion: 1, runtime: 'Electron fixture',
    notes: t('stage.telemetryReportNotes'), ...value, history,
  });
  assert.doesNotMatch(serialized, /203\.0\.113\.5|private-track-identifier/);
  assert.match(serialized, /"configuredFps": 120/);
  assert.match(serialized, /"fps": 60/);
  assert.match(serialized, /"maxBitrateKbps": null/);
});
