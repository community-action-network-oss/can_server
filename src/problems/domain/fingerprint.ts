import { normalise as foldText } from './privacy/detect.js';

/** Hex digest of a string. The caller supplies a keyed HMAC (infra), so this file stays pure. */
export type HashFn = (s: string) => string;

export const SHINGLE_WORDS = 5;
export const SKETCH_SIZE = 16;
export const MATCH_THRESHOLD = 0.6;

/** NFKC and digit folding (shared with privacy), lowercase, punctuation stripped, whitespace collapsed. */
export function normalise(text: string): string {
  return foldText(text)
    .text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Overlapping word windows; a text shorter than one window is a single shingle. */
export function shingles(normalised: string, n = SHINGLE_WORDS): string[] {
  const w = normalised.split(' ').filter(Boolean);
  if (w.length === 0) return [];
  if (w.length <= n) return [w.join(' ')];
  const out: string[] = [];
  for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' '));
  return out;
}

/** Bottom-k sketch: the SKETCH_SIZE smallest distinct shingle hashes, sorted. */
export function fingerprint(text: string, hash: HashFn): string[] {
  const set = new Set(shingles(normalise(text)).map(hash));
  return [...set].sort().slice(0, SKETCH_SIZE);
}

/** Bottom-k Jaccard estimate: share of the k smallest hashes of the union found in both. */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  const union = [...new Set([...a, ...b])].sort().slice(0, SKETCH_SIZE);
  return union.filter((h) => sa.has(h) && sb.has(h)).length / union.length;
}
