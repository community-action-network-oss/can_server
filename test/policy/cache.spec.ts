import {
  DecisionCache,
  CacheRefused,
  cacheKey,
} from '../../src/policy/domain/cache.js';

const decision = {
  outcome: 'needs_revision',
  rule_ids: ['FIX-PROC-1'],
  confidence: 0.9,
};

describe('decision cache', () => {
  it('keys on policy version, dp and input hash, and a key reveals nothing of the input', () => {
    const input = 'call me on +44 20 7946 0958 or a@b.example';
    const k = cacheKey('base@0.0.1+abc', 'DP-NAMING', 'h1');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toContain('DP-NAMING');
    expect(k).not.toBe(cacheKey('base@0.0.2+abc', 'DP-NAMING', 'h1'));
    expect(k).not.toBe(cacheKey('base@0.0.1+abc', 'DP-TONE', 'h1'));
    expect(k).not.toContain(input);
  });

  it('stores and returns structured output', () => {
    const c = new DecisionCache({ ttlMs: 1000, maxEntries: 5 });
    c.set('k', decision);
    expect(c.get('k')).toEqual(decision);
  });

  it('refuses planted email, phone, url and a 500 character string, at any depth', () => {
    const c = new DecisionCache({ ttlMs: 1000, maxEntries: 5 });
    for (const bad of [
      'a.person@example.org',
      'call +44 20 7946 0958',
      '020 7946 0958',
      'see https://example.org/x',
      'www.example.org',
      'x'.repeat(500),
    ]) {
      expect(() => c.set('k', { reasons: [{ note: bad }] }), bad).toThrow(
        CacheRefused,
      );
      expect(() => c.set('k', { [bad]: 1 }), bad).toThrow(CacheRefused);
    }
    expect(c.size).toBe(0);
  });

  it('expires by ttl and evicts least recently used', () => {
    let t = 0;
    const c = new DecisionCache<number>({
      ttlMs: 100,
      maxEntries: 2,
      now: () => t,
    });
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3); // evicts b
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    t = 101;
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(1);
  });
});
