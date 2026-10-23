/**
 * Live indicators pulse a few cycles when a broadcast starts and then rest.
 * An infinite pulse kept the compositor producing a frame on every refresh of
 * the display (240 Hz monitors) for as long as anyone was live.
 *
 * Views rebuilt with innerHTML recreate the indicator, which would restart its
 * CSS animation. The clock remembers when each indicator first appeared and
 * returns a negative `animation-delay`, so a rebuilt indicator resumes at the
 * same phase. Once the last cycle has passed, the delay places the animation
 * past its end: it is created already finished and produces no frames.
 */
export class LivePulseClock {
  private readonly since = new Map<string, number>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Inline `animation-delay` value for the indicator identified by `key`. */
  delay(key: string): string {
    const now = this.now();
    let since = this.since.get(key);
    if (since === undefined) {
      since = now;
      this.since.set(key, since);
    }
    return `${-Math.round(now - since)}ms`;
  }

  /** Forgets indicators that are no longer live, so a later broadcast pulses again. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.since.keys()) {
      if (!keys.has(key)) this.since.delete(key);
    }
  }
}
