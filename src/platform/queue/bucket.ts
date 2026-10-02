import type { Clock } from '../ports.js';
import type { JobClass } from './queue.port.js';

/** Pure token bucket on an injected clock; throttles re-moderation batches. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock,
  ) {
    this.tokens = capacity;
    this.last = clock.now().getTime();
  }
  /** Takes n tokens if available. */
  tryTake(n = 1): boolean {
    const t = this.clock.now().getTime();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((t - this.last) / 1000) * this.refillPerSec,
    );
    this.last = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** One bucket per class; a class with no spec is unlimited. */
export class ClassBuckets {
  private readonly b = new Map<JobClass, TokenBucket>();
  constructor(
    spec: Partial<Record<JobClass, { capacity: number; refillPerSec: number }>>,
    clock: Clock,
  ) {
    for (const [c, s] of Object.entries(spec))
      this.b.set(
        c as JobClass,
        new TokenBucket(s.capacity, s.refillPerSec, clock),
      );
  }
  tryTake(c: JobClass, n = 1): boolean {
    return this.b.get(c)?.tryTake(n) ?? true;
  }
}
