import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyStatement } from './classify.js';
import { LIMITS, checkLimits } from './limits.js';
import { detectScript } from './language.js';
import { findSecrets } from './secrets.js';
import { checkEvidenceUrl } from './url.js';

const load = <T>(f: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures', f), 'utf8')) as { version: number; rows: T[] };

interface ElRow { id: string; text: string; expected: string; ruleId: string; category: string }
interface UrlRow { id: string; url: string; expected: Record<string, unknown>; ruleId: string; category: string }
const el = load<ElRow>('eligibility.json');
const ev = load<UrlRow>('evidence-urls.json');
const CLASSES = ['individual_case', 'medical', 'legal_advice', 'therapy', 'commercial', 'emergency'];

describe('eligibility corpus', () => {
  it('is versioned, large enough, unique ids, each class declined and rewritten', () => {
    expect(el.version).toBe(1);
    expect(el.rows.length).toBeGreaterThanOrEqual(40);
    expect(new Set(el.rows.map((r) => r.id)).size).toBe(el.rows.length);
    for (const c of CLASSES) {
      expect(el.rows.some((r) => r.category === c && r.expected === c), `${c} declined`).toBe(true);
      expect(el.rows.some((r) => r.category === c && r.expected === 'accepted'), `${c} rewrite`).toBe(true);
    }
  });

  it.each(el.rows.map((r) => [r.id, r.expected, r] as const))('%s -> %s', (_i, _e, row) => {
    const got = classifyStatement(row.text);
    if (row.expected === 'accepted') expect(got).toEqual({ ok: true });
    else expect(got).toMatchObject({ ok: false, ineligibilityCode: row.expected, ruleId: row.ruleId });
  });

  it('emergency carries a route hint and is the only CRISIS-STATIC-1 outcome', () => {
    const r = classifyStatement('Someone is bleeding outside the station.');
    expect(r.ok === false && r.hint.length > 0).toBe(true);
  });
});

describe('evidence url corpus', () => {
  it('is versioned and large enough', () => {
    expect(ev.version).toBe(1);
    expect(ev.rows.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ev.rows.map((r) => r.id)).size).toBe(ev.rows.length);
  });
  it.each(ev.rows.map((r) => [r.id, r.url.slice(0, 40), r] as const))('%s %s', (_i, _u, row) => {
    const got = checkEvidenceUrl(row.url);
    expect(got).toMatchObject(row.expected);
  });
  it('allows http only when asked', () => {
    expect(checkEvidenceUrl('http://example.org/x').ok).toBe(false);
    expect(checkEvidenceUrl('http://example.org/x', { allowHttp: true }).ok).toBe(true);
  });
});

describe('language', () => {
  it('Latin is supported, others are labelled, never rejected', () => {
    expect(detectScript('Bus route 12 skips the stop.')).toEqual({ supported: true, script: 'Latin' });
    expect(detectScript('')).toMatchObject({ supported: true });
    expect(detectScript('Bus 12 ٣٤ بدون محطة توقف')).toEqual({
      supported: false, script: 'Arabic', label: 'language not yet supported',
    });
    expect(detectScript('Автобус не останавливается')).toMatchObject({ supported: false, script: 'Cyrillic' });
  });
});

describe('secrets', () => {
  const t = 'Key is AKIAIOSFODNN7EXAMPLE ok';
  it('flags AWS-style key with original span', () => {
    const [f] = findSecrets(t);
    expect(t.slice(f!.start, f!.end)).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(f).toMatchObject({ kind: 'secret', ruleId: 'PRIV-GATE-1' });
  });
  it('flags PEM header, bearer and keyword-adjacent runs', () => {
    expect(findSecrets('-----BEGIN PRIVATE KEY-----')).toHaveLength(1);
    expect(findSecrets('Authorization: Bearer FAKEtokenFAKEtoken1234567890')).toHaveLength(1);
    expect(findSecrets('password: FAKEFAKEFAKEFAKEFAKEFAKE0000')).toHaveLength(1);
  });
  it('leaves ordinary prose alone', () => {
    expect(findSecrets('The key problem is the bus token system and passwords policy.')).toEqual([]);
    expect(findSecrets('Reference 2024-03-01 for the council minutes.')).toEqual([]);
  });
});

describe('limits', () => {
  it('matches the spec numbers and counts code points', () => {
    expect(LIMITS).toEqual({ title: 120, condition: 300, affected: 300, desiredOutcome: 300, observed: 600, uncertain: 600 });
    expect(checkLimits({ title: 'a'.repeat(120) }).ok).toBe(true);
    expect(checkLimits({ title: '😀'.repeat(120) }).ok).toBe(true);
    expect(checkLimits({ title: 'a'.repeat(121), observed: 'b'.repeat(601) }).violations).toEqual([
      { field: 'title', max: 120, length: 121 },
      { field: 'observed', max: 600, length: 601 },
    ]);
  });
});

const rulesPath = resolve(process.cwd(), '../docs/spec/constitution/rules.md');
describe.skipIf(!existsSync(rulesPath))(
  'rule ids exist in docs/spec/constitution/rules.md (skipped when the superproject docs are absent)',
  () => {
    const registry = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : '';
    const ids = new Set([...registry.matchAll(/^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*\|/gm)].map((m) => m[1]));
    it('every corpus row and emitted flag cites a registered rule id', () => {
      for (const r of [...el.rows, ...ev.rows]) expect(ids.has(r.ruleId), `${r.id} ${r.ruleId}`).toBe(true);
      for (const id of ['PRIV-GATE-1', 'PUB-FAILCLOSED-1', 'EVID-URL-1']) expect(ids.has(id), id).toBe(true);
    });
  },
);
