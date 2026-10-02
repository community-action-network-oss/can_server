import { describe, expect, it } from 'vitest';
import { generateHandle } from './handle.js';
import { ADJECTIVES, NOUNS } from './wordlists.js';

const BLOCK =
  `sex nazi kill dead hate bomb drug porn rape slur damn hell crap shit fuck piss cock dick
cunt whore slut nigg fag kike spic chink jew muslim christ allah satan devil trump biden gun gay
bitch arse nude murder terror abuse`.split(/\s+/);

const mulberry32 = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('wordlists', () => {
  for (const [name, list] of [
    ['adjectives', ADJECTIVES],
    ['nouns', NOUNS],
  ] as const) {
    it(`${name}: size, shape, unique`, () => {
      expect(list.length).toBeGreaterThanOrEqual(120);
      expect(new Set(list).size).toBe(list.length);
      for (const w of list) expect(w).toMatch(/^[a-z]{3,8}$/);
    });
    it(`${name}: no blocklisted substring`, () => {
      expect(BLOCK.length).toBeGreaterThanOrEqual(30);
      for (const w of list)
        for (const b of BLOCK) expect(w.toLowerCase()).not.toContain(b);
    });
  }
  it('adjectives and nouns do not overlap', () => {
    expect(ADJECTIVES.filter((w) => NOUNS.includes(w))).toEqual([]);
  });
});

describe('generateHandle', () => {
  it('is deterministic for a seed and well formed; collisions under 1%', () => {
    const rng = mulberry32(42);
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      const h = generateHandle(rng);
      expect(h).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
      seen.add(h);
    }
    expect(10000 - seen.size).toBeLessThan(100);
    expect(generateHandle(mulberry32(7))).toBe(generateHandle(mulberry32(7)));
  });
});
