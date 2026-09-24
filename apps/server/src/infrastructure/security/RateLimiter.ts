import { LIMITS } from '@monky/shared';

export class RateLimiter {
  private userMessageTimestamps: Map<string, number[]> = new Map();
  private windows = new Map<string, number>();
  private reservations = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cleanupIntervalMs: number = 60_000) {
    // Periodically evict stale entries so the map does not grow unboundedly as
    // users who stop sending messages would otherwise never be removed.
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    // Do not keep the process alive solely for this timer.
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Checks if an action is within rate limits.
   * Returns true if allowed, false if rate limited.
   */
  public checkLimit(
    userIdOrIp: string,
    maxCount: number = LIMITS.RATE_LIMIT_MAX_MESSAGES,
    windowMs: number = LIMITS.RATE_LIMIT_WINDOW_MS
  ): boolean {
    this.windows.set(userIdOrIp, Math.max(windowMs, this.windows.get(userIdOrIp) ?? 0));
    const now = Date.now();
    let timestamps = this.userMessageTimestamps.get(userIdOrIp);

    if (!timestamps) {
      timestamps = [];
      this.userMessageTimestamps.set(userIdOrIp, timestamps);
    }

    // Filter out timestamps outside the sliding window
    const validTimestamps = timestamps.filter((t) => now - t < windowMs);

    if (validTimestamps.length >= maxCount) {
      this.userMessageTimestamps.set(userIdOrIp, validTimestamps);
      return false; // Rate limit exceeded
    }

    validTimestamps.push(now);
    this.userMessageTimestamps.set(userIdOrIp, validTimestamps);
    return true;
  }

  /**
   * Responde se a ação passaria, **sem** gastar uma vaga. Existe para o caso em
   * que só o fracasso deve contar: limitar toda tentativa de conexão gastaria a
   * cota com quem entra normalmente, e uma casa atrás de um NAT só — várias
   * pessoas no mesmo IP público — se bloquearia sozinha ao reconectar depois de
   * uma queda do servidor (#372).
   */
  public peek(
    userIdOrIp: string,
    maxCount: number = LIMITS.RATE_LIMIT_MAX_MESSAGES,
    windowMs: number = LIMITS.RATE_LIMIT_WINDOW_MS
  ): boolean {
    const now = Date.now();
    const timestamps = this.userMessageTimestamps.get(userIdOrIp);
    if (!timestamps) return true;
    return timestamps.filter((t) => now - t < windowMs).length < maxCount;
  }

  public reserve(key: string, maxCount: number, windowMs: number): (() => void) | null {
    const active = this.reservations.get(key) ?? 0;
    const failures = (this.userMessageTimestamps.get(key) ?? [])
      .filter((time) => Date.now() - time < windowMs).length;
    if (active + failures >= maxCount) return null;
    this.reservations.set(key, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.reservations.get(key) ?? 1) - 1;
      if (remaining === 0) this.reservations.delete(key);
      else this.reservations.set(key, remaining);
    };
  }

  public cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.userMessageTimestamps.entries()) {
      const valid = timestamps.filter((t) => now - t < (this.windows.get(key) ?? LIMITS.RATE_LIMIT_WINDOW_MS));
      if (valid.length === 0) {
        this.userMessageTimestamps.delete(key);
        this.windows.delete(key);
      } else {
        this.userMessageTimestamps.set(key, valid);
      }
    }
  }

  /** Stops the periodic cleanup timer. Call on server shutdown. */
  public dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.userMessageTimestamps.clear();
    this.windows.clear();
    this.reservations.clear();
  }
}
