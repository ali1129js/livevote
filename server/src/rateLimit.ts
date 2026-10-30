/** Fixed-window in-memory rate limiter. Good enough for one free-tier instance. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the action is allowed. */
  allow(key: string, now: number): boolean {
    const e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (e.count >= this.max) return false;
    e.count += 1;
    return true;
  }

  /** Drop expired windows so the map can't grow forever. */
  prune(now: number): void {
    for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
  }

  get size(): number {
    return this.hits.size;
  }
}

/**
 * Best-effort client IP. `trustedHops` is how many reverse proxies we sit behind
 * (Render = 1). With 0 we never trust X-Forwarded-For (it would be spoofable).
 */
export function clientIp(xForwardedFor: string | string[] | undefined, remote: string | undefined, trustedHops: number): string {
  if (trustedHops > 0 && xForwardedFor) {
    const raw = Array.isArray(xForwardedFor) ? xForwardedFor.join(",") : xForwardedFor;
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const candidate = parts[parts.length - trustedHops];
    if (candidate) return candidate;
  }
  return remote ?? "unknown";
}
