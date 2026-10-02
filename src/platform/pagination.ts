import { ApiException } from './errors.js';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export const encodeCursor = (obj: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

const bad = () =>
  new ApiException(400, 'validation_failed', 'Invalid cursor', {
    cursor: 'Invalid cursor',
  });

export function decodeCursor(str: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) throw bad();
  try {
    const v: unknown = JSON.parse(
      Buffer.from(str, 'base64url').toString('utf8'),
    );
    if (v && typeof v === 'object' && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw bad();
}

/** Default 20, max 50; junk or non-positive falls back to the default. */
export function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (
    raw === undefined ||
    raw === null ||
    raw === '' ||
    !Number.isFinite(n) ||
    n < 1
  )
    return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}
