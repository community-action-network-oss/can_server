import { sha256 } from './hash.js';

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /\+?\d[\d\s().-]{7,}\d/;
const URL_RE = /https?:\/\/|www\./i;
const MAX_STRING = 400;

export class CacheRefused extends Error {}

export const cacheKey = (
  policyVersion: string,
  dpId: string,
  normalizedInputHash: string,
): string => sha256(`${policyVersion}|${dpId}|${normalizedInputHash}`);

function assertNoPii(v: unknown): void {
  if (typeof v === 'string') {
    if (v.length > MAX_STRING)
      throw new CacheRefused('string too long for the decision cache');
    if (EMAIL.test(v) || PHONE.test(v) || URL_RE.test(v))
      throw new CacheRefused('value looks like PII');
  } else if (Array.isArray(v)) v.forEach(assertNoPii);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      assertNoPii(k);
      assertNoPii(x);
    }
}

/** LRU with TTL. Stores structured decision output only, never input text. */
export class DecisionCache<V = unknown> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  constructor(
    private readonly opts: {
      ttlMs: number;
      maxEntries: number;
      now?: () => number;
    },
  ) {}

  private now = () => (this.opts.now ?? Date.now)();

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e); // refresh recency
    return e.value;
  }

  set(key: string, value: V): void {
    assertNoPii(value);
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.opts.ttlMs });
    while (this.map.size > this.opts.maxEntries)
      this.map.delete(this.map.keys().next().value as string);
  }

  get size(): number {
    return this.map.size;
  }
}
