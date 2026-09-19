export interface VideoStatsReport {
  get(id: string): unknown;
  forEach(callback: (value: unknown, key: string) => void): void;
}

export interface VideoSendLimits {
  encodings: readonly { rid?: string; maxBitrate?: number; maxFramerate?: number }[];
  degradationPreference?: string;
}

export interface VideoRtpDiagnostics {
  id: string;
  direction: 'outbound' | 'inbound';
  timestampMs: number | null;
  intervalMs: number | null;
  fps: number | null;
  sentFps: number | null;
  width: number | null;
  height: number | null;
  bitrateKbps: number | null;
  codec: string | null;
  codecParameters: string | null;
  encoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  encodeTimeMs: number | null;
  decodeTimeMs: number | null;
  qualityLimitationReason: 'none' | 'cpu' | 'bandwidth' | 'other' | null;
  targetBitrateKbps: number | null;
  maxBitrateKbps: number | null;
  maxFramerate: number | null;
  degradationPreference: string | null;
  sourceFps: number | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  packetLossPct: number | null;
  jitterMs: number | null;
  jitterBufferMs: number | null;
  roundTripTimeMs: number | null;
  availableOutgoingBitrateKbps: number | null;
  framesEncoded: number | null;
  keyFramesEncoded: number | null;
  keyFramesPerSecond: number | null;
  framesSent: number | null;
  framesReceived: number | null;
  framesDecoded: number | null;
  framesDropped: number | null;
}

export interface VideoPlaybackInput {
  timestampMs: number;
  totalFrames: number;
  droppedFrames: number;
  sourceKey: string;
  width: number;
  height: number;
  paused: boolean;
}

export interface VideoPlaybackDiagnostics {
  fps: number | null;
  width: number | null;
  height: number | null;
  totalFrames: number | null;
  droppedFrames: number | null;
  droppedFramesDelta: number | null;
  intervalMs: number | null;
  paused: boolean;
}

type StatsRecord = Record<string, unknown>;
type Direction = VideoRtpDiagnostics['direction'];
type QualityLimitationReason = NonNullable<VideoRtpDiagnostics['qualityLimitationReason']>;

interface CodecInfo {
  category: 'media' | 'repair' | 'non-video' | 'unknown';
  codec: string | null;
  codecParameters: string | null;
}

interface StreamSnapshot {
  timestampMs: number | null;
  bytes: number | null;
  framesEncoded: number | null;
  framesSent: number | null;
  framesReceived: number | null;
  framesDecoded: number | null;
  totalEncodeTime: number | null;
  totalDecodeTime: number | null;
  keyFramesEncoded: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
  jitterBufferDelay: number | null;
  jitterBufferEmittedCount: number | null;
  sourceTimestampMs: number | null;
  sourceFrames: number | null;
}

interface StreamHistory {
  sourceKey: string | null;
  codecId: string | null;
  snapshot: StreamSnapshot;
}

interface PlaybackHistory {
  sourceKey: string;
  timestampMs: number;
  totalFrames: number;
  droppedFrames: number;
}

interface TargetHistory {
  outbound: Map<string, StreamHistory>;
  inbound: Map<string, StreamHistory>;
  playback: PlaybackHistory | null;
}

const REPAIR_CODECS = new Set(['rtx', 'red', 'ulpfec', 'flexfec-03']);

function isRecord(value: unknown): value is StatsRecord {
  return typeof value === 'object' && value !== null;
}

function readString(record: StatsRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readBoolean(record: StatsRecord, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

function readFiniteNumber(record: StatsRecord, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNonNegativeNumber(record: StatsRecord, key: string): number | null {
  const value = readFiniteNumber(record, key);
  return value !== null && value >= 0 ? value : null;
}

function readPositiveDimension(record: StatsRecord, key: string): number | null {
  const value = readFiniteNumber(record, key);
  return value !== null && value > 0 ? value : null;
}

function readTimestampMs(record: StatsRecord): number | null {
  const value = readFiniteNumber(record, 'timestamp');
  return value !== null && value >= 0 ? value : null;
}

function readVideoCounter(record: StatsRecord, key: string): number | null {
  return readNonNegativeNumber(record, key);
}

function readVideoKind(record: StatsRecord): string | null {
  const kind = readString(record, 'kind');
  if (kind !== null) return kind;
  return readString(record, 'mediaType');
}

function isVideoReport(record: StatsRecord): boolean {
  return readVideoKind(record) === 'video';
}

function intervalMs(currentTimestampMs: number | null, previousTimestampMs: number | null, reset: boolean): number | null {
  if (reset || currentTimestampMs === null || previousTimestampMs === null) return null;
  const delta = currentTimestampMs - previousTimestampMs;
  return delta > 0 ? delta : null;
}

function nonNegativeDelta(current: number | null, previous: number | null, validIntervalMs: number | null): number | null {
  if (validIntervalMs === null || current === null || previous === null) return null;
  const delta = current - previous;
  return delta >= 0 ? delta : null;
}

function ratePerSecond(current: number | null, previous: number | null, validIntervalMs: number | null): number | null {
  const delta = nonNegativeDelta(current, previous, validIntervalMs);
  return delta === null || validIntervalMs === null ? null : (delta * 1000) / validIntervalMs;
}

function bitrateKbps(currentBytes: number | null, previousBytes: number | null, validIntervalMs: number | null): number | null {
  const delta = nonNegativeDelta(currentBytes, previousBytes, validIntervalMs);
  return delta === null || validIntervalMs === null ? null : (delta * 8) / validIntervalMs;
}

function averageMsPerUnit(
  currentTotal: number | null,
  previousTotal: number | null,
  currentCount: number | null,
  previousCount: number | null,
  validIntervalMs: number | null
): number | null {
  const countDelta = nonNegativeDelta(currentCount, previousCount, validIntervalMs);
  if (countDelta === null || countDelta === 0) return null;
  const totalDelta = nonNegativeDelta(currentTotal, previousTotal, validIntervalMs);
  return totalDelta === null ? null : (totalDelta * 1000) / countDelta;
}

function packetLossPct(
  currentLost: number | null,
  previousLost: number | null,
  currentReceived: number | null,
  previousReceived: number | null,
  validIntervalMs: number | null
): number | null {
  if (validIntervalMs === null || currentLost === null || previousLost === null
    || currentReceived === null || previousReceived === null) {
    return null;
  }
  const lostDelta = currentLost - previousLost;
  const receivedDelta = currentReceived - previousReceived;
  if (lostDelta < 0 || receivedDelta < 0) return null;
  const denominator = lostDelta + receivedDelta;
  return denominator > 0 ? (lostDelta * 100) / denominator : null;
}

function readQualityLimitationReason(record: StatsRecord): QualityLimitationReason | null {
  const value = readString(record, 'qualityLimitationReason');
  switch (value) {
    case 'none':
    case 'cpu':
    case 'bandwidth':
    case 'other':
      return value;
    default:
      return null;
  }
}

function kbpsFromBps(value: number | null): number | null {
  return value === null ? null : value / 1000;
}

function msFromSeconds(value: number | null): number | null {
  return value === null ? null : value * 1000;
}

function normalizeCodecName(subtype: string): string {
  const lowered = subtype.toLowerCase();
  if (lowered === 'h264') return 'H264';
  if (lowered === 'vp8') return 'VP8';
  if (lowered === 'vp9') return 'VP9';
  if (lowered.startsWith('av1')) return 'AV1';
  return subtype.toUpperCase();
}

function resolveCodecInfo(reports: Map<string, StatsRecord>, rtpReport: StatsRecord): CodecInfo {
  const codecId = readString(rtpReport, 'codecId');
  if (!codecId) {
    return { category: 'unknown', codec: null, codecParameters: null };
  }
  const codecReport = reports.get(codecId);
  if (!codecReport) {
    return { category: 'unknown', codec: null, codecParameters: null };
  }
  const mimeType = readString(codecReport, 'mimeType');
  if (!mimeType) {
    return { category: 'unknown', codec: null, codecParameters: null };
  }

  const [mediaType, subtype] = mimeType.split('/');
  if (!mediaType || !subtype) {
    return { category: 'unknown', codec: null, codecParameters: null };
  }
  if (mediaType.toLowerCase() !== 'video') {
    return { category: 'non-video', codec: null, codecParameters: null };
  }
  if (REPAIR_CODECS.has(subtype.toLowerCase())) {
    return { category: 'repair', codec: null, codecParameters: null };
  }
  return {
    category: 'media',
    codec: normalizeCodecName(subtype),
    codecParameters: readString(codecReport, 'sdpFmtpLine'),
  };
}

function linkedVideoSource(reports: Map<string, StatsRecord>, rtpReport: StatsRecord): StatsRecord | null {
  const mediaSourceId = readString(rtpReport, 'mediaSourceId');
  if (!mediaSourceId) return null;
  const sourceReport = reports.get(mediaSourceId);
  return sourceReport && readString(sourceReport, 'type') === 'media-source' && isVideoReport(sourceReport)
    ? sourceReport
    : null;
}

function linkedCandidatePair(reports: Map<string, StatsRecord>, rtpReport: StatsRecord): StatsRecord | null {
  const transportId = readString(rtpReport, 'transportId');
  if (!transportId) return null;
  const transportReport = reports.get(transportId);
  if (!transportReport || readString(transportReport, 'type') !== 'transport') return null;
  const pairId = readString(transportReport, 'selectedCandidatePairId');
  if (!pairId) return null;
  const pairReport = reports.get(pairId);
  return pairReport && readString(pairReport, 'type') === 'candidate-pair' ? pairReport : null;
}

function selectedEncoding(limits: VideoSendLimits | undefined, rid: string | null): VideoSendLimits['encodings'][number] | null {
  if (!limits || limits.encodings.length === 0) return null;
  if (limits.encodings.length === 1) return limits.encodings[0];
  if (!rid) return null;
  return limits.encodings.find(encoding => encoding.rid === rid) ?? null;
}

function toReports(stats: VideoStatsReport): Map<string, StatsRecord> {
  const reports = new Map<string, StatsRecord>();
  stats.forEach((value, key) => {
    if (isRecord(value)) reports.set(key, value);
  });
  return reports;
}

export class VideoDiagnosticsSampler {
  private readonly targets = new Map<object, TargetHistory>();

  public sampleOutbound(
    target: object,
    stats: VideoStatsReport,
    limits?: VideoSendLimits,
    sourceKey?: string
  ): VideoRtpDiagnostics[] {
    return this.sampleRtp('outbound', target, stats, sourceKey, limits);
  }

  public sampleInbound(target: object, stats: VideoStatsReport, sourceKey?: string): VideoRtpDiagnostics[] {
    return this.sampleRtp('inbound', target, stats, sourceKey);
  }

  public samplePlayback(target: object, input: VideoPlaybackInput): VideoPlaybackDiagnostics {
    const history = this.ensureTarget(target);
    const currentTimestampMs = Number.isFinite(input.timestampMs) && input.timestampMs >= 0 ? input.timestampMs : null;
    const currentTotalFrames = Number.isFinite(input.totalFrames) && input.totalFrames >= 0 ? input.totalFrames : null;
    const currentDroppedFrames = Number.isFinite(input.droppedFrames) && input.droppedFrames >= 0 ? input.droppedFrames : null;
    const validCounts = currentTotalFrames !== null
      && currentDroppedFrames !== null
      && currentDroppedFrames <= currentTotalFrames;
    const sourceChanged = !history.playback || history.playback.sourceKey !== input.sourceKey;
    const currentIntervalMs = history.playback && currentTimestampMs !== null && !sourceChanged
      ? intervalMs(currentTimestampMs, history.playback.timestampMs, false)
      : null;

    const width = Number.isFinite(input.width) && input.width > 0 ? input.width : null;
    const height = Number.isFinite(input.height) && input.height > 0 ? input.height : null;

    let fps: number | null = null;
    let droppedFramesDelta: number | null = null;

    if (validCounts && history.playback && currentIntervalMs !== null && !sourceChanged) {
      const shownFrames = currentTotalFrames - currentDroppedFrames;
      const previousShownFrames = history.playback.totalFrames - history.playback.droppedFrames;
      const shownDelta = shownFrames - previousShownFrames;
      const droppedDelta = currentDroppedFrames - history.playback.droppedFrames;
      if (shownDelta >= 0) {
        fps = (shownDelta * 1000) / currentIntervalMs;
      }
      if (droppedDelta >= 0) {
        droppedFramesDelta = droppedDelta;
      }
      if (shownDelta < 0 || droppedDelta < 0) {
        fps = null;
        droppedFramesDelta = null;
      }
    }

    if (validCounts && currentTimestampMs !== null) {
      history.playback = {
        sourceKey: input.sourceKey,
        timestampMs: currentTimestampMs,
        totalFrames: currentTotalFrames,
        droppedFrames: currentDroppedFrames,
      };
    } else {
      history.playback = null;
    }

    return {
      fps,
      width,
      height,
      totalFrames: validCounts ? currentTotalFrames : null,
      droppedFrames: validCounts ? currentDroppedFrames : null,
      droppedFramesDelta,
      intervalMs: sourceChanged ? null : currentIntervalMs,
      paused: input.paused,
    };
  }

  public retainTargets(targets: ReadonlySet<object>): void {
    for (const target of this.targets.keys()) {
      if (!targets.has(target)) this.targets.delete(target);
    }
  }

  public clear(): void {
    this.targets.clear();
  }

  private ensureTarget(target: object): TargetHistory {
    let history = this.targets.get(target);
    if (!history) {
      history = {
        outbound: new Map<string, StreamHistory>(),
        inbound: new Map<string, StreamHistory>(),
        playback: null,
      };
      this.targets.set(target, history);
    }
    return history;
  }

  private sampleRtp(
    direction: Direction,
    target: object,
    stats: VideoStatsReport,
    sourceKey: string | undefined,
    limits?: VideoSendLimits
  ): VideoRtpDiagnostics[] {
    const reports = toReports(stats);
    const history = this.ensureTarget(target);
    const streamHistory = direction === 'outbound' ? history.outbound : history.inbound;
    const currentSourceKey = sourceKey ?? null;
    const seenIds = new Set<string>();
    const diagnostics: VideoRtpDiagnostics[] = [];

    for (const [reportKey, report] of reports.entries()) {
      if (readString(report, 'type') !== `${direction}-rtp` || !isVideoReport(report)) continue;
      if (direction === 'outbound' && readBoolean(report, 'active') === false) continue;

      const codecInfo = resolveCodecInfo(reports, report);
      if (codecInfo.category === 'repair' || codecInfo.category === 'non-video') continue;

      const id = readString(report, 'id') ?? reportKey;
      const previous = streamHistory.get(id);
      const codecId = readString(report, 'codecId');
      const baselineChanged = !previous
        || previous.sourceKey !== currentSourceKey
        || previous.codecId !== codecId;
      const timestampMs = readTimestampMs(report);
      const currentIntervalMs = previous ? intervalMs(timestampMs, previous.snapshot.timestampMs, baselineChanged) : null;
      const linkedSource = direction === 'outbound' ? linkedVideoSource(reports, report) : null;
      const sourceTimestampMs = linkedSource ? readTimestampMs(linkedSource) : null;
      const sourceInterval = previous
        ? intervalMs(sourceTimestampMs, previous.snapshot.sourceTimestampMs, baselineChanged)
        : null;

      const bytes = readVideoCounter(report, direction === 'outbound' ? 'bytesSent' : 'bytesReceived');
      const framesEncoded = readVideoCounter(report, 'framesEncoded');
      const framesSent = readVideoCounter(report, 'framesSent');
      const framesReceived = readVideoCounter(report, 'framesReceived');
      const framesDecoded = readVideoCounter(report, 'framesDecoded');
      const totalEncodeTime = readNonNegativeNumber(report, 'totalEncodeTime');
      const totalDecodeTime = readNonNegativeNumber(report, 'totalDecodeTime');
      const keyFramesEncoded = readVideoCounter(report, 'keyFramesEncoded');
      const packetsLost = readVideoCounter(report, 'packetsLost');
      const packetsReceived = readVideoCounter(report, 'packetsReceived');
      const jitterBufferDelay = readNonNegativeNumber(report, 'jitterBufferDelay');
      const jitterBufferEmittedCount = readVideoCounter(report, 'jitterBufferEmittedCount');
      const sourceFrames = linkedSource ? readVideoCounter(linkedSource, 'frames') : null;

      const fpsFromInterval = direction === 'outbound'
        ? ratePerSecond(framesEncoded, previous?.snapshot.framesEncoded ?? null, currentIntervalMs)
        : ratePerSecond(framesDecoded, previous?.snapshot.framesDecoded ?? null, currentIntervalMs);
      const fps = fpsFromInterval ?? readNonNegativeNumber(report, 'framesPerSecond');

      const pair = linkedCandidatePair(reports, report);
      const encoding = direction === 'outbound' ? selectedEncoding(limits, readString(report, 'rid')) : null;

      diagnostics.push({
        id,
        direction,
        timestampMs,
        intervalMs: baselineChanged ? null : currentIntervalMs,
        fps,
        sentFps: direction === 'outbound'
          ? ratePerSecond(framesSent, previous?.snapshot.framesSent ?? null, currentIntervalMs)
          : null,
        width: readPositiveDimension(report, 'frameWidth'),
        height: readPositiveDimension(report, 'frameHeight'),
        bitrateKbps: bitrateKbps(bytes, previous?.snapshot.bytes ?? null, currentIntervalMs),
        codec: codecInfo.codec,
        codecParameters: codecInfo.codecParameters,
        encoderImplementation: readString(report, 'encoderImplementation'),
        powerEfficientEncoder: readBoolean(report, 'powerEfficientEncoder'),
        encodeTimeMs: direction === 'outbound'
          ? averageMsPerUnit(
            totalEncodeTime,
            previous?.snapshot.totalEncodeTime ?? null,
            framesEncoded,
            previous?.snapshot.framesEncoded ?? null,
            currentIntervalMs
          )
          : null,
        decodeTimeMs: direction === 'inbound'
          ? averageMsPerUnit(
            totalDecodeTime,
            previous?.snapshot.totalDecodeTime ?? null,
            framesDecoded,
            previous?.snapshot.framesDecoded ?? null,
            currentIntervalMs
          )
          : null,
        qualityLimitationReason: readQualityLimitationReason(report),
        targetBitrateKbps: direction === 'outbound'
          ? kbpsFromBps(readNonNegativeNumber(report, 'targetBitrate'))
          : null,
        maxBitrateKbps: direction === 'outbound'
          ? kbpsFromBps(
            encoding && typeof encoding.maxBitrate === 'number' && Number.isFinite(encoding.maxBitrate) && encoding.maxBitrate >= 0
              ? encoding.maxBitrate
              : null
          )
          : null,
        maxFramerate: direction === 'outbound'
          ? (
            encoding && typeof encoding.maxFramerate === 'number'
            && Number.isFinite(encoding.maxFramerate) && encoding.maxFramerate >= 0
              ? encoding.maxFramerate
              : null
          )
          : null,
        degradationPreference: direction === 'outbound' && typeof limits?.degradationPreference === 'string'
          ? limits.degradationPreference
          : null,
        sourceFps: direction === 'outbound'
          ? (linkedSource ? readNonNegativeNumber(linkedSource, 'framesPerSecond') : null)
            ?? ratePerSecond(sourceFrames, previous?.snapshot.sourceFrames ?? null, sourceInterval)
          : null,
        sourceWidth: direction === 'outbound' && linkedSource ? readPositiveDimension(linkedSource, 'width') : null,
        sourceHeight: direction === 'outbound' && linkedSource ? readPositiveDimension(linkedSource, 'height') : null,
        packetLossPct: direction === 'inbound'
          ? packetLossPct(
            packetsLost,
            previous?.snapshot.packetsLost ?? null,
            packetsReceived,
            previous?.snapshot.packetsReceived ?? null,
            currentIntervalMs
          )
          : null,
        jitterMs: direction === 'inbound' ? msFromSeconds(readNonNegativeNumber(report, 'jitter')) : null,
        jitterBufferMs: direction === 'inbound'
          ? averageMsPerUnit(
            jitterBufferDelay,
            previous?.snapshot.jitterBufferDelay ?? null,
            jitterBufferEmittedCount,
            previous?.snapshot.jitterBufferEmittedCount ?? null,
            currentIntervalMs
          )
          : null,
        roundTripTimeMs: msFromSeconds(pair ? readNonNegativeNumber(pair, 'currentRoundTripTime') : null),
        availableOutgoingBitrateKbps: direction === 'outbound'
          ? kbpsFromBps(pair ? readNonNegativeNumber(pair, 'availableOutgoingBitrate') : null)
          : null,
        framesEncoded,
        keyFramesEncoded,
        keyFramesPerSecond: direction === 'outbound'
          ? ratePerSecond(keyFramesEncoded, previous?.snapshot.keyFramesEncoded ?? null, currentIntervalMs)
          : null,
        framesSent,
        framesReceived,
        framesDecoded,
        framesDropped: readVideoCounter(report, 'framesDropped'),
      });

      seenIds.add(id);
      streamHistory.set(id, {
        sourceKey: currentSourceKey,
        codecId,
        snapshot: {
          timestampMs,
          bytes,
          framesEncoded,
          framesSent,
          framesReceived,
          framesDecoded,
          totalEncodeTime,
          totalDecodeTime,
          keyFramesEncoded,
          packetsLost,
          packetsReceived,
          jitterBufferDelay,
          jitterBufferEmittedCount,
          sourceTimestampMs,
          sourceFrames,
        },
      });
    }

    for (const existingId of streamHistory.keys()) {
      if (!seenIds.has(existingId)) streamHistory.delete(existingId);
    }

    return diagnostics;
  }
}
