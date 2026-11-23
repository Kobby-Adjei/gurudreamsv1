/** Tiny fixed-window in-memory rate limiter (per process). Good enough to blunt abuse of verify/checkout. */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const e = this.hits.get(key);
    if (!e || t - e.windowStart >= this.windowMs) {
      if (this.hits.size >= this.maxKeys) this.sweep(t);
      this.hits.set(key, { windowStart: t, count: 1 });
      return true;
    }
    e.count += 1;
    return e.count <= this.limit;
  }

  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(k);
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}
