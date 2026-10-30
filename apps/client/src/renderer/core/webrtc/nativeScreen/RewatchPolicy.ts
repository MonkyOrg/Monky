import { clientLog } from '../../ClientLogService';
import type { NativeScreenWatchState } from './RemoteScreenPresentations';

/**
 * A publisher quality change retires its old instance before announcing the replacement;
 * viewers see that gap as source-unavailable for a few hundred ms.
 */
export const SOURCE_REPLACEMENT_GRACE_MS = 8000;
/**
 * A broken connection to a still-announced source is watched again automatically;
 * the attempts restart once a picture plays, so only a persistent failure offers a retry.
 */
export const AUTOMATIC_REWATCH_DELAYS_MS = [1000, 3000, 8000] as const;

/** What the policy keeps on each presentation of a Watch. */
export interface RewatchEntry {
  readonly state: NativeScreenWatchState;
  /** undefined: never started; a timer: masking a source replacement; null: finished. */
  replacementGrace?: ReturnType<typeof setTimeout> | null;
}

/** What the policy needs from the presentations of one call. */
export interface RewatchHost<P extends RewatchEntry> {
  /** The call retired or was replaced: nothing is attempted for it anymore. */
  ended(): boolean;
  /** The presentation now shown for `key`. */
  presentation(key: string): P | undefined;
  /** Whether the viewer still watches what `entry` presents. */
  wanted(entry: P): boolean;
  /** Replaces `entry` with a new attempt and settles, never rejecting, once that attempt did. */
  restart(entry: P): Promise<void>;
  /** What the stage presents for a Watch changed. */
  changed(): void;
}

/** Automatic reconnection of one Watch. */
export interface Rewatch {
  attempts: number;
  // Scheduled or awaiting its replacement presentation; the stage shows it as connecting.
  pending: boolean;
}

/** What a Watch's new state asks of its automatic reconnection. */
export type RewatchStep =
  | { readonly kind: 'reset' }
  | { readonly kind: 'keep' }
  | { readonly kind: 'retry'; readonly attempt: number; readonly delayMs: number };

/** A picture starts the attempts over; only a broken connection is attempted again, a bounded number of times. */
export function rewatchStep(state: NativeScreenWatchState, rewatch: Rewatch | undefined): RewatchStep {
  if (state.state === 'playing') return { kind: 'reset' };
  if (state.state !== 'unavailable' || state.reason !== 'connection-failed') return { kind: 'keep' };
  const attempts = rewatch?.attempts ?? 0;
  if (rewatch?.pending || attempts >= AUTOMATIC_REWATCH_DELAYS_MS.length) return { kind: 'keep' };
  return { kind: 'retry', attempt: attempts + 1, delayMs: AUTOMATIC_REWATCH_DELAYS_MS[attempts] };
}

/** A failure the policy is still handling is presented as reconnecting, not as an error with a retry action. */
export function presentedWatchState(state: NativeScreenWatchState, handling: boolean): NativeScreenWatchState {
  return handling && state.state === 'unavailable' ? { state: 'connecting' } : state;
}

/**
 * How the Watches of one call recover by themselves: a source its publisher replaced reads as
 * reconnecting while the replacement may still come, and a broken connection to a source still
 * announced is watched again after a growing delay.
 */
export class RewatchPolicy<P extends RewatchEntry> {
  private readonly rewatches = new Map<string, Rewatch & { timer: ReturnType<typeof setTimeout> | null }>();

  constructor(private readonly host: RewatchHost<P>) {}

  /** Present a retired source as reconnecting until its replacement is announced; only a source that stays gone becomes a failure with a retry action. */
  public awaitReplacement(entry: P): void {
    if (entry.replacementGrace !== undefined || entry.state.state !== 'unavailable'
      || entry.state.reason !== 'source-unavailable') return;
    entry.replacementGrace = setTimeout(() => {
      entry.replacementGrace = null;
      this.host.changed();
    }, SOURCE_REPLACEMENT_GRACE_MS);
  }

  public endReplacement(entry: P): void {
    if (entry.replacementGrace) clearTimeout(entry.replacementGrace);
    entry.replacementGrace = null;
  }

  /** `entry`, the presentation of `key`, reached a new state. */
  public outcome(key: string, entry: P): void {
    const previous = this.rewatches.get(key);
    const step = rewatchStep(entry.state, previous);
    if (step.kind === 'reset') {
      if (previous?.timer) clearTimeout(previous.timer);
      this.rewatches.delete(key);
      return;
    }
    if (step.kind === 'keep' || this.host.ended()) return;
    const rewatch = previous ?? { attempts: 0, timer: null, pending: false };
    this.rewatches.set(key, rewatch);
    rewatch.pending = true;
    rewatch.attempts = step.attempt;
    clientLog.info('SCREEN_SHARE', 'Native screen watch will reconnect automatically',
      { attempt: step.attempt, delayMs: step.delayMs });
    rewatch.timer = setTimeout(() => {
      rewatch.timer = null;
      // A manual retry, a new source or an ended Watch already replaced this presentation.
      if (this.host.ended() || this.host.presentation(key) !== entry || !this.host.wanted(entry)) {
        rewatch.pending = false;
        this.host.changed();
        return;
      }
      void this.host.restart(entry).finally(() => {
        rewatch.pending = false;
        const current = this.host.presentation(key);
        if (current && current !== entry && this.rewatches.get(key) === rewatch) this.outcome(key, current);
        this.host.changed();
      });
    }, step.delayMs);
  }

  /** What the stage shows for `entry`: connecting while a replacement or a reconnection is pending. */
  public presented(key: string, entry: P): NativeScreenWatchState {
    return presentedWatchState(entry.state, !!entry.replacementGrace || this.rewatches.get(key)?.pending === true);
  }

  /** The call retires: no grace nor reconnection outlives it. */
  public end(entries: Iterable<P>): void {
    for (const entry of entries) this.endReplacement(entry);
    for (const rewatch of this.rewatches.values()) {
      if (rewatch.timer) clearTimeout(rewatch.timer);
      rewatch.timer = null;
      rewatch.pending = false;
    }
    this.rewatches.clear();
  }
}
