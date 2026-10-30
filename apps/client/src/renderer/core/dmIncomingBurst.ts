const BURST_WINDOW_MS = 1_500;

export interface IncomingBurstOptions {
  /** The message sound. */
  sound: () => void;
  /** Shows the toast for `peer`, replacing the previous one: a single message, or `count` of them. */
  toast: (peer: string, count: number) => void;
  /** Quiet time that ends a burst, and the shortest gap between two sounds. */
  windowMs?: number;
}

/**
 * Turns the messages that arrive together from one friend into one
 * notification (DM-11): when a friend comes back online, their whole outbox
 * lands at once. The first message rings and shows its toast right away; the
 * rest of the burst only updates the toast to "N new messages" once it
 * settles. A sound never plays twice within the window, even for different
 * friends, so blips never pile up into one loud, clipped noise.
 */
export class DmIncomingBurst {
  private readonly bursts = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>();
  private lastSoundAt = Number.NEGATIVE_INFINITY;
  private readonly windowMs: number;

  constructor(private readonly options: IncomingBurstOptions) {
    this.windowMs = options.windowMs ?? BURST_WINDOW_MS;
  }

  add(peer: string): void {
    const burst = this.bursts.get(peer);
    if (burst) {
      burst.count += 1;
      clearTimeout(burst.timer);
      burst.timer = setTimeout(() => this.settle(peer), this.windowMs);
      return;
    }
    const now = Date.now();
    if (now - this.lastSoundAt >= this.windowMs) {
      this.lastSoundAt = now;
      this.options.sound();
    }
    this.options.toast(peer, 1);
    this.bursts.set(peer, { count: 1, timer: setTimeout(() => this.settle(peer), this.windowMs) });
  }

  private settle(peer: string): void {
    const burst = this.bursts.get(peer);
    if (!burst) return;
    this.bursts.delete(peer);
    if (burst.count > 1) this.options.toast(peer, burst.count);
  }

  dispose(): void {
    for (const burst of this.bursts.values()) clearTimeout(burst.timer);
    this.bursts.clear();
  }
}
