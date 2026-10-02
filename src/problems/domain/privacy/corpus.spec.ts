import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectPrivacyFlags } from './detect.js';

interface Row {
  id: string;
  text: string;
  expected: { kind: string; start: number; end: number }[];
  ruleId: string;
  category: 'positive' | 'negative' | 'multilingual' | 'adversarial' | 'known_gap';
  note: string;
}

const corpus = JSON.parse(
  readFileSync(resolve(process.cwd(), 'test/fixtures/privacy-flags.json'), 'utf8'),
) as { version: number; rows: Row[] };

describe('privacy corpus', () => {
  it('is versioned, large enough and has unique ids', () => {
    expect(corpus.version).toBe(1);
    expect(corpus.rows.length).toBeGreaterThanOrEqual(60);
    expect(new Set(corpus.rows.map((r) => r.id)).size).toBe(corpus.rows.length);
    for (const c of ['positive', 'negative', 'multilingual', 'adversarial', 'known_gap']) {
      expect(corpus.rows.some((r) => r.category === c), c).toBe(true);
    }
  });

  it.each(corpus.rows.map((r) => [r.id, r.category, r.note, r] as const))(
    '%s (%s) %s',
    (_id, _cat, _note, row) => {
      const got = detectPrivacyFlags(row.text).map(({ kind, start, end }) => ({ kind, start, end }));
      expect(got).toEqual(row.expected);
      // spans index the original text
      for (const e of row.expected) expect(row.text.slice(e.start, e.end).length).toBeGreaterThan(0);
    },
  );

  it('known_gap rows assert non-detection of the unflagged identifier', () => {
    for (const r of corpus.rows.filter((x) => x.category === 'known_gap')) {
      expect(r.expected).toEqual([]);
    }
  });
});

describe('flag details', () => {
  it('NAME-1 suggestion follows a role word, generic otherwise', () => {
    const [mayor] = detectPrivacyFlags('Mayor Dana Okoro cut the ribbon.');
    expect(mayor!.suggestion).toBe('Mayor of {jurisdiction}, officeholder as of {YYYY-MM}');
    const [plain] = detectPrivacyFlags('Please ask Dana Okoro.');
    expect(plain!.suggestion).toBe('Describe the role or institution instead of the person');
  });

  it('maps kinds to rule ids', () => {
    const f = detectPrivacyFlags('Call 555-0100 or ask Dana Okoro.');
    expect(f.map((x) => [x.kind, x.ruleId])).toEqual([
      ['phone', 'PRIV-GATE-1'],
      ['person_name', 'NAME-1'],
    ]);
  });
});

// Specs live in the superproject; can_server may be checked out alone.
const rulesPath = resolve(process.cwd(), '../docs/spec/constitution/rules.md');
describe.skipIf(!existsSync(rulesPath))(
  'rule ids exist in docs/spec/constitution/rules.md (skipped when the superproject docs are absent)',
  () => {
    const registry = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : '';
    const ids = new Set([...registry.matchAll(/^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*\|/gm)].map((m) => m[1]));

    it('every corpus row cites a registered rule id', () => {
      for (const r of corpus.rows) expect(ids.has(r.ruleId), `${r.id} ${r.ruleId}`).toBe(true);
    });

    it('every flag the detector can emit cites a registered rule id', () => {
      for (const r of corpus.rows) {
        for (const f of detectPrivacyFlags(r.text)) expect(ids.has(f.ruleId), f.ruleId).toBe(true);
      }
    });
  },
);
