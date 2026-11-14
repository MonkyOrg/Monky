import { readNumber, readString, records, type StatsRecord, type StatsReportLike } from './rtcStats';

/**
 * Watches how the call's audio actually sounds, from the `getStats()` the call
 * already reads every two seconds for its ping: no extra measurement runs.
 *
 * A call can stay "connected" while the voice breaks up. The causes leave
 * different traces, and telling them apart is what this is for:
 * - received audio lost or late on the network: loss, jitter and the samples
 *   the decoder had to invent (concealment), per sender;
 * - received audio heard seconds behind, after a stall let it pile up in the
 *   jitter buffer;
 * - our audio lost on the way out: the loss the server or peer reports back;
 * - our own microphone pipeline (capture, noise suppression) falling behind
 *   when the renderer is overloaded: fewer seconds of audio produced than
 *   seconds of real time, which every listener hears as gaps;
 * - the audio device running dry while playing.
 *
 * A bad reading has to repeat before it is logged, and a good one has to
 * repeat before the call is called recovered, so a single hiccup does not
 * flood the log. A summary is logged every few minutes and when the call ends.
 */

/** One link of the call and what `getStats()` said about it. */
export interface LinkStatsSample {
  /** Stable name of the link: the peer on P2P, the transport direction on the SFU. */
  readonly link: string;
  readonly stats: StatsReportLike;
  /** Who sent a received track, by its `trackIdentifier`, or null when unknown. */
  readonly senderOf: (trackIdentifier: string) => string | null;
}

/** One measurement of the whole call: the ping every view shows and the stats it came from. */
export interface CallStatsSample {
  readonly ping: number | null;
  readonly links: readonly LinkStatsSample[];
}

export type VoiceQualityReason =
  | 'inbound-loss' | 'concealment' | 'jitter' | 'buffer-delay' | 'outbound-loss' | 'mic-capture' | 'playout';

export interface VoiceQualityMetrics {
  /** Received audio lost on the way, worst stream, in %. */
  readonly inboundLossPct: number | null;
  /** Received audio the decoder had to invent, audible part only, worst stream, in %. */
  readonly concealedPct: number | null;
  readonly jitterMs: number | null;
  /**
   * Mean time received audio waited in the jitter buffer, worst stream: how far
   * behind it is heard. It can stay high long after a stall that let audio pile up.
   */
  readonly jitterBufferMs: number | null;
  /** Received audio sped up or slowed down to drain or fill the jitter buffer, worst stream, in %. */
  readonly stretchedPct: number | null;
  /** Sender of the worst received stream, when known. */
  readonly worstSender: string | null;
  /** Received audio streams that carried media in this interval. */
  readonly inboundStreams: number;
  /** Our audio lost on the way out, as the server or the peer reports it, in %. */
  readonly outboundLossPct: number | null;
  /**
   * Seconds of microphone audio produced per second of real time, in %. Below
   * 100 the capture pipeline, noise suppression included, is falling behind.
   */
  readonly micCapturePct: number | null;
  /** Playout the audio device had to fill with synthesized samples, in %. */
  readonly playoutSynthesizedPct: number | null;
  readonly rttMs: number | null;
}

/** Fields of the worst values seen over a period; the sender and stream count describe one sample only. */
type WorstMetrics = Omit<VoiceQualityMetrics, 'worstSender' | 'inboundStreams'>;

export interface VoiceQualityLog {
  warn(message: string, data: Record<string, unknown>): void;
  info(message: string, data: Record<string, unknown>): void;
}

/** Below these, an interval carried too little audio for its ratios to mean anything. */
const MIN_INBOUND_PACKETS = 25;
const MIN_LOSS_PACKETS = 50;
const MIN_SOURCE_INTERVAL_MS = 1000;
const MIN_PLAYOUT_SECONDS = 0.5;

const LIMITS = {
  lossPct: 5,
  concealedPct: 5,
  jitterMs: 60,
  jitterBufferMs: 500,
  outboundLossPct: 5,
  micCapturePct: 95,
  playoutSynthesizedPct: 5,
} as const;

function isAudio(record: StatsRecord): boolean {
  return record.kind === 'audio' || record.mediaType === 'audio';
}

/** Growth of a counter since the previous report, or null when it is missing or restarted. */
function grew(current: StatsRecord, previous: StatsRecord, key: string): number | null {
  const now = readNumber(current, key);
  const before = readNumber(previous, key);
  if (now === null || before === null || now < before) return null;
  return now - before;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function worse(a: number | null, b: number | null, pick: (x: number, y: number) => number): number | null {
  if (a === null) return b;
  return b === null ? a : pick(a, b);
}

function emptyMetrics(rttMs: number | null): VoiceQualityMetrics {
  return {
    inboundLossPct: null, concealedPct: null, jitterMs: null, jitterBufferMs: null, stretchedPct: null,
    worstSender: null, inboundStreams: 0, outboundLossPct: null, micCapturePct: null,
    playoutSynthesizedPct: null, rttMs,
  };
}

function mergeWorst(a: WorstMetrics | null, b: WorstMetrics): WorstMetrics {
  if (!a) return pickWorst(b);
  return {
    inboundLossPct: worse(a.inboundLossPct, b.inboundLossPct, Math.max),
    concealedPct: worse(a.concealedPct, b.concealedPct, Math.max),
    jitterMs: worse(a.jitterMs, b.jitterMs, Math.max),
    jitterBufferMs: worse(a.jitterBufferMs, b.jitterBufferMs, Math.max),
    stretchedPct: worse(a.stretchedPct, b.stretchedPct, Math.max),
    outboundLossPct: worse(a.outboundLossPct, b.outboundLossPct, Math.max),
    micCapturePct: worse(a.micCapturePct, b.micCapturePct, Math.min),
    playoutSynthesizedPct: worse(a.playoutSynthesizedPct, b.playoutSynthesizedPct, Math.max),
    rttMs: worse(a.rttMs, b.rttMs, Math.max),
  };
}

function pickWorst(metrics: WorstMetrics): WorstMetrics {
  const { inboundLossPct, concealedPct, jitterMs, jitterBufferMs, stretchedPct, outboundLossPct,
    micCapturePct, playoutSynthesizedPct, rttMs } = metrics;
  return { inboundLossPct, concealedPct, jitterMs, jitterBufferMs, stretchedPct, outboundLossPct,
    micCapturePct, playoutSynthesizedPct, rttMs };
}

function hasMeasurement(metrics: VoiceQualityMetrics): boolean {
  return metrics.inboundStreams > 0 || metrics.outboundLossPct !== null
    || metrics.micCapturePct !== null || metrics.playoutSynthesizedPct !== null;
}

/** What is wrong with one interval, judged against `LIMITS`. */
export function voiceQualityReasons(metrics: VoiceQualityMetrics): VoiceQualityReason[] {
  const reasons: VoiceQualityReason[] = [];
  const atLeast = (value: number | null, limit: number) => value !== null && value >= limit;
  if (atLeast(metrics.inboundLossPct, LIMITS.lossPct)) reasons.push('inbound-loss');
  if (atLeast(metrics.concealedPct, LIMITS.concealedPct)) reasons.push('concealment');
  if (atLeast(metrics.jitterMs, LIMITS.jitterMs)) reasons.push('jitter');
  if (atLeast(metrics.jitterBufferMs, LIMITS.jitterBufferMs)) reasons.push('buffer-delay');
  if (atLeast(metrics.outboundLossPct, LIMITS.outboundLossPct)) reasons.push('outbound-loss');
  if (metrics.micCapturePct !== null && metrics.micCapturePct < LIMITS.micCapturePct) reasons.push('mic-capture');
  if (atLeast(metrics.playoutSynthesizedPct, LIMITS.playoutSynthesizedPct)) reasons.push('playout');
  return reasons;
}

interface Episode {
  readonly since: number;
  readonly reasons: Set<VoiceQualityReason>;
  worst: WorstMetrics;
}

interface Period {
  readonly since: number;
  samples: number;
  degradedSamples: number;
  episodes: number;
  readonly reasons: Map<VoiceQualityReason, number>;
  worst: WorstMetrics | null;
}

export class VoiceQualityMonitor {
  /** Bad intervals in a row before the call is logged as degraded. */
  static DEGRADED_AFTER = 2;
  /** Good intervals in a row before a degraded call is logged as recovered. */
  static RECOVERED_AFTER = 3;
  static SUMMARY_INTERVAL_MS = 10 * 60_000;

  /** Last report of every stream, by link and stats id: ids repeat across the mesh's peer connections. */
  private previous = new Map<string, StatsRecord>();
  private badStreak = 0;
  private goodStreak = 0;
  private streakWorst: WorstMetrics | null = null;
  private episode: Episode | null = null;
  private period: Period | null = null;

  constructor(
    private readonly log: VoiceQualityLog,
    private readonly context: () => Record<string, unknown>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Reads one interval of the call, logs what changed, and returns what was measured, if anything. */
  public sample(sample: CallStatsSample): VoiceQualityMetrics | null {
    const metrics = this.measure(sample);
    if (!hasMeasurement(metrics)) return null;
    const now = this.now();
    const reasons = voiceQualityReasons(metrics);
    if (!this.period) this.period = { since: now, samples: 0, degradedSamples: 0, episodes: 0, reasons: new Map(), worst: null };
    const period = this.period;
    period.samples++;
    period.worst = mergeWorst(period.worst, metrics);

    if (reasons.length) {
      period.degradedSamples++;
      for (const reason of reasons) period.reasons.set(reason, (period.reasons.get(reason) ?? 0) + 1);
      this.badStreak++;
      this.goodStreak = 0;
      const streakWorst = mergeWorst(this.streakWorst, metrics);
      this.streakWorst = streakWorst;
      if (this.episode) {
        for (const reason of reasons) this.episode.reasons.add(reason);
        this.episode.worst = mergeWorst(this.episode.worst, metrics);
      } else if (this.badStreak >= VoiceQualityMonitor.DEGRADED_AFTER) {
        this.episode = { since: now, reasons: new Set(reasons), worst: streakWorst };
        period.episodes++;
        this.log.warn('Voice quality degraded', { reasons, metrics, context: this.context() });
      }
    } else {
      this.goodStreak++;
      this.badStreak = 0;
      this.streakWorst = null;
      if (this.episode && this.goodStreak >= VoiceQualityMonitor.RECOVERED_AFTER) {
        this.log.info('Voice quality recovered', this.describeEpisode(this.episode, now));
        this.episode = null;
      }
    }

    if (now - period.since >= VoiceQualityMonitor.SUMMARY_INTERVAL_MS) {
      this.logSummary(period, now);
      this.period = null;
    }
    return metrics;
  }

  /** The call ended or moved: closes what is open and forgets every stream. Idempotent. */
  public reset(): void {
    const now = this.now();
    if (this.episode) {
      this.log.info('Voice quality still degraded when the call ended', this.describeEpisode(this.episode, now));
    }
    if (this.period?.samples) this.logSummary(this.period, now);
    this.previous.clear();
    this.badStreak = 0;
    this.goodStreak = 0;
    this.streakWorst = null;
    this.episode = null;
    this.period = null;
  }

  private describeEpisode(episode: Episode, now: number): Record<string, unknown> {
    return { durationMs: now - episode.since, reasons: [...episode.reasons], worst: episode.worst };
  }

  private logSummary(period: Period, now: number): void {
    this.log.info('Voice quality summary', {
      periodMs: now - period.since,
      samples: period.samples,
      degradedSamples: period.degradedSamples,
      episodes: period.episodes,
      reasons: Object.fromEntries(period.reasons),
      worst: period.worst,
      context: this.context(),
    });
  }

  private measure(sample: CallStatsSample): VoiceQualityMetrics {
    const current = new Map<string, StatsRecord>();
    let result: VoiceQualityMetrics = emptyMetrics(sample.ping);
    let worstScore = -1;

    for (const { link, stats, senderOf } of sample.links) {
      const changes = (type: string) => records(stats, type).filter(isAudio).flatMap(record => {
        const id = readString(record, 'id');
        if (!id) return [];
        const key = `${link}\u0000${id}`;
        current.set(key, record);
        const previous = this.previous.get(key);
        return previous ? [{ record, previous }] : [];
      });

      for (const { record, previous } of changes('inbound-rtp')) {
        const packets = grew(record, previous, 'packetsReceived');
        if (packets === null) continue;
        // Duplicates make packetsLost go down; that is no loss.
        const lost = Math.max(0, (readNumber(record, 'packetsLost') ?? 0) - (readNumber(previous, 'packetsLost') ?? 0));
        // A muted or paused sender sends nothing: an idle stream says nothing about quality.
        if (packets + lost < MIN_INBOUND_PACKETS) continue;
        const samples = grew(record, previous, 'totalSamplesReceived');
        const concealed = grew(record, previous, 'concealedSamples');
        const silent = grew(record, previous, 'silentConcealedSamples') ?? 0;
        const emitted = grew(record, previous, 'jitterBufferEmittedCount');
        const delay = grew(record, previous, 'jitterBufferDelay');
        const stretched = (grew(record, previous, 'insertedSamplesForDeceleration') ?? 0)
          + (grew(record, previous, 'removedSamplesForAcceleration') ?? 0);
        const jitter = readNumber(record, 'jitter');

        const lossPct = packets + lost >= MIN_LOSS_PACKETS ? round(lost / (packets + lost) * 100) : null;
        const concealedPct = samples && concealed !== null ? round(Math.max(0, concealed - silent) / samples * 100) : null;
        const score = Math.max(lossPct ?? 0, concealedPct ?? 0);
        const trackIdentifier = readString(record, 'trackIdentifier');
        if (score > worstScore) {
          worstScore = score;
          result = { ...result, worstSender: trackIdentifier ? senderOf(trackIdentifier) : null };
        }
        result = {
          ...result,
          inboundStreams: result.inboundStreams + 1,
          inboundLossPct: worse(result.inboundLossPct, lossPct, Math.max),
          concealedPct: worse(result.concealedPct, concealedPct, Math.max),
          jitterMs: worse(result.jitterMs, jitter !== null ? Math.round(jitter * 1000) : null, Math.max),
          jitterBufferMs: worse(result.jitterBufferMs,
            emitted && delay !== null ? Math.round(delay / emitted * 1000) : null, Math.max),
          stretchedPct: worse(result.stretchedPct, samples ? round(stretched / samples * 100) : null, Math.max),
        };
      }

      const sending = changes('outbound-rtp').some(({ record, previous }) => (grew(record, previous, 'packetsSent') ?? 0) > 0);
      for (const { record } of changes('remote-inbound-rtp')) {
        const fraction = readNumber(record, 'fractionLost');
        if (sending && fraction !== null) {
          result = { ...result, outboundLossPct: worse(result.outboundLossPct, round(fraction * 100), Math.max) };
        }
      }

      for (const { record, previous } of changes('media-source')) {
        const produced = grew(record, previous, 'totalSamplesDuration');
        const elapsedMs = grew(record, previous, 'timestamp');
        if (!produced || elapsedMs === null || elapsedMs < MIN_SOURCE_INTERVAL_MS) continue;
        // Capped at 100: the counter advances in 10 ms frames, so a sample can land a frame ahead.
        const pct = Math.min(100, round(produced / (elapsedMs / 1000) * 100));
        result = { ...result, micCapturePct: worse(result.micCapturePct, pct, Math.min) };
      }

      for (const { record, previous } of changes('media-playout')) {
        const played = grew(record, previous, 'totalSamplesDuration');
        const synthesized = grew(record, previous, 'synthesizedSamplesDuration');
        if (played === null || played < MIN_PLAYOUT_SECONDS || synthesized === null) continue;
        result = {
          ...result,
          playoutSynthesizedPct: worse(result.playoutSynthesizedPct, round(synthesized / played * 100), Math.max),
        };
      }
    }

    this.previous = current;
    return result;
  }
}
