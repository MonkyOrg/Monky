import type { VideoPlaybackDiagnostics, VideoRtpDiagnostics } from '../core/webrtc/videoDiagnostics';
import { t } from '../i18n';

export interface VideoTelemetrySnapshot {
  kind: 'sender' | 'receiver';
  media: 'screen' | 'camera';
  transport: 'p2p' | 'sfu';
  sampledAt: string;
  documentVisibility: DocumentVisibilityState;
  requested: { width: number; height: number; fps: number; bitrateKbps: number } | null;
  capture: {
    width: number | null;
    height: number | null;
    configuredFps: number | null;
    contentHint: string;
    readyState: MediaStreamTrackState;
  } | null;
  streams: Array<{ endpoint: number; data: VideoRtpDiagnostics }>;
  playback: VideoPlaybackDiagnostics | null;
  readErrors: number;
}

function number(value: number | null, decimals = 0, suffix = ''): string {
  return `${value === null || !Number.isFinite(value) ? '--' : value.toFixed(decimals)}${suffix}`;
}

function range(values: Array<number | null>, decimals = 0, suffix = ''): string {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!known.length) return number(null, decimals, suffix);
  const min = Math.min(...known).toFixed(decimals);
  const max = Math.max(...known).toFixed(decimals);
  const unknown = known.length < values.length ? ' / --' : '';
  return `${min === max ? min : `${min}-${max}`}${unknown}${suffix}`;
}

function distinct(values: Array<string | null>): string {
  return [...new Set(values.map(value => value || '--'))].join(' / ') || '--';
}

function resolution(width: number | null, height: number | null): string | null {
  return width && height ? `${width}x${height}` : null;
}

export function formatVideoTelemetry(snapshot: VideoTelemetrySnapshot, mode: 'simple' | 'complete'): string {
  const data = snapshot.streams.map(stream => stream.data);
  const isSender = snapshot.kind === 'sender';
  const bitrate = data.length && data.every(stream => stream.bitrateKbps !== null)
    ? data.reduce((total, stream) => total + (stream.bitrateKbps ?? 0), 0)
    : null;
  const lines = [
    `${snapshot.transport.toUpperCase()} - ${t(isSender ? 'stage.telemetrySending' : 'stage.telemetryReceiving')}`,
  ];
  if (!data.length) {
    lines.push(t(isSender ? 'stage.telemetryLocalOnly' : 'stage.telemetryNoRtp'));
  } else if (data.length > 1) {
    lines.push(t('stage.telemetryStreams', { count: data.length }));
  }
  lines.push(
    `${t('stage.telemetryCodec')}: ${distinct(data.map(stream => stream.codec))}`,
    `${t('stage.telemetryRtpFps')}: ${range(data.map(stream => stream.fps))}`,
    `${t('stage.telemetryResolution')}: ${distinct(data.map(stream => resolution(stream.width, stream.height)))}`,
    `${t(isSender && data.length > 1 ? 'stage.telemetryTotalBitrate' : 'stage.telemetryBitrate')}: ${number(bitrate, 0, ' kbps')}`
  );

  if (mode === 'complete') {
    if (snapshot.requested) {
      const requested = snapshot.requested;
      lines.push(`${t('stage.telemetryRequested')}: ${resolution(requested.width, requested.height)} / ${requested.fps} FPS`);
    }
    if (snapshot.capture) {
      const capture = snapshot.capture;
      lines.push(`${t('stage.telemetryCaptureConfig')}: ${resolution(capture.width, capture.height) || '--'} / ${number(capture.configuredFps)} FPS`);
    }
    if (isSender) {
      const reasons = data.map(stream => {
        switch (stream.qualityLimitationReason) {
          case 'none': return t('stage.telemetryLimitNone');
          case 'cpu': return t('stage.telemetryLimitCpu');
          case 'bandwidth': return t('stage.telemetryLimitBandwidth');
          case 'other': return t('stage.telemetryLimitOther');
          default: return null;
        }
      });
      lines.push(
        `${t('stage.telemetrySourceFps')}: ${range(data.map(stream => stream.sourceFps))}`,
        `${t('stage.telemetrySentFps')}: ${range(data.map(stream => stream.sentFps))}`,
        `${t('stage.telemetryEncoder')}: ${distinct(data.map(stream => stream.encoderImplementation))}`,
        `${t('stage.telemetryEncodeTime')}: ${range(data.map(stream => stream.encodeTimeMs), 1, ' ms')}`,
        `${t('stage.telemetryLimitation')}: ${distinct(reasons)}`
      );
    } else {
      lines.push(
        `${t('stage.telemetryLoss')}: ${range(data.map(stream => stream.packetLossPct), 1, '%')}`,
        `${t('stage.telemetryJitter')}: ${range(data.map(stream => stream.jitterMs), 1, ' ms')}`,
        `${t('stage.telemetryBuffer')}: ${range(data.map(stream => stream.jitterBufferMs), 1, ' ms')}`,
        `${t('stage.telemetryDecodeTime')}: ${range(data.map(stream => stream.decodeTimeMs), 1, ' ms')}`
      );
    }
    lines.push(
      `${t('stage.telemetryPlayerFps')}: ${number(snapshot.playback?.fps ?? null)}${snapshot.documentVisibility === 'hidden' ? ` (${t('stage.telemetryHidden')})` : ''}`,
      `${t('stage.telemetryPlayerDrops')}: ${number(snapshot.playback?.droppedFramesDelta ?? null)}`,
      t('stage.telemetryCopyHint')
    );
  }

  if (snapshot.readErrors) lines.push(t('stage.telemetryReadErrors', { count: snapshot.readErrors }));
  return lines.join('\n');
}

export function serializeVideoTelemetry(
  snapshot: VideoTelemetrySnapshot,
  userAgent: string,
  history: readonly VideoTelemetrySnapshot[] = []
): string {
  return JSON.stringify({
    schemaVersion: 1,
    runtime: userAgent,
    notes: t('stage.telemetryReportNotes'),
    ...snapshot,
    history,
  }, null, 2);
}
