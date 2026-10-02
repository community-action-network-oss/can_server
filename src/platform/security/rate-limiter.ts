export interface RateLimiter {
  /** Records a hit; false when the key is over `limit` within `windowMs`. */
  hit(key: string, limit: number, windowMs: number): Promise<boolean>;
}
export const RATE_LIMITER = Symbol('RateLimiter');

// ponytail: in-memory, per process; plan 07 makes it Postgres-backed
export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  async hit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000)
      for (const [k, v] of this.hits)
        if (now - v[v.length - 1]! >= windowMs) this.hits.delete(k);
    return true;
  }
}
