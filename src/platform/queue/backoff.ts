import type { Random } from './queue.port.js';

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 15 * 60 * 1000;

/** Delay before retry after the given (1-based) failed attempt: 1s, 2s, 4s ... capped at 15 min, half-jittered. */
export function backoffMs(attempt: number, rnd: Random): number {
  const d = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.floor(d / 2 + (d / 2) * rnd.next());
}
