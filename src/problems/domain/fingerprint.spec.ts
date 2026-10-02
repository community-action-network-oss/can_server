import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import pairs from '../../../test/fixtures/reposts.json' with { type: 'json' };
import {
  fingerprint,
  normalise,
  shingles,
  similarity,
  MATCH_THRESHOLD,
  SKETCH_SIZE,
} from './fingerprint.js';

const key = Buffer.from('fixed-test-key-not-a-secret-0001');
const hash = (s: string) =>
  createHmac('sha256', key).update(s).digest('hex').slice(0, 16);

describe('fingerprint', () => {
  it('normalises case, punctuation, width and whitespace', () => {
    expect(normalise('  Hello,\n WORLD!!  １２３ ')).toBe('hello world 123');
  });

  it('shingles by 5 words, short text is one shingle', () => {
    expect(shingles('a b c d e f')).toEqual(['a b c d e', 'b c d e f']);
    expect(shingles('a b')).toEqual(['a b']);
    expect(shingles('')).toEqual([]);
  });

  it('sketch is at most 16 sorted hex hashes and holds no text', () => {
    const f = fingerprint(pairs[0]!.a, hash);
    expect(f.length).toBeLessThanOrEqual(SKETCH_SIZE);
    expect(f.every((h) => /^[0-9a-f]{16}$/.test(h))).toBe(true);
  });

  it('a different key gives disjoint hashes', () => {
    const other = (s: string) =>
      createHmac('sha256', 'other-key').update(s).digest('hex').slice(0, 16);
    expect(similarity(fingerprint(pairs[0]!.a, hash), fingerprint(pairs[0]!.a, other))).toBe(0);
  });

  it('has at least 20 corpus pairs', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(20);
  });

  for (const p of pairs) {
    it(`${p.id}: ${p.note} -> ${p.similar ? 'similar' : 'different'}`, () => {
      const s = similarity(fingerprint(p.a, hash), fingerprint(p.b, hash));
      if (p.similar) expect(s).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      else expect(s).toBeLessThan(MATCH_THRESHOLD);
    });
  }
});
