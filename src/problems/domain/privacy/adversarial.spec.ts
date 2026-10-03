import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyStatement } from '../eligibility/classify.js';
import { findSecrets } from '../eligibility/secrets.js';
import { checkEvidenceUrl } from '../eligibility/url.js';
import { detectPrivacyFlags } from './detect.js';

// 07-u01: adversarial corpus. Rows are fictional (reserved ranges, *.test hosts).
// Failure messages cite row ids only, never payloads.
const load = <T>(f: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures', f), 'utf8')) as { version: number; rows: T[] };

interface PvRow {
  id: string; text: string; ruleId: string; category: string; note: string;
  expected: { kind: string; covers: string }[];
  leaks?: string;
}
interface ElRow {
  id: string; text: string; expected: string; ruleId: string; category: string; note: string; knownGap?: boolean;
}
interface UrRow {
  id: string; url: string; expected: Record<string, unknown>; ruleId: string; category: string; note: string; knownGap?: boolean;
}
const pv = load<PvRow>('adversarial-privacy.json');
const el = load<ElRow>('adversarial-eligibility.json');
const ur = load<UrRow>('adversarial-urls.json');

/** True when some flag of `kind` spans the first occurrence of `covers` in the original text. */
function covered(text: string, flags: { kind: string; start: number; end: number }[], covers: string, kind?: string) {
  const at = text.indexOf(covers);
  if (at < 0) return false;
  return flags.some((f) => (!kind || f.kind === kind) && f.start <= at && f.end >= at + covers.length);
}

describe('adversarial corpus shape', () => {
  it('has at least 80 rows in total, unique ids, versioned', () => {
    for (const c of [pv, el, ur]) expect(c.version).toBe(1);
    const ids = [...pv.rows, ...el.rows, ...ur.rows].map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(80);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every known_gap row has a note and a current-behaviour assertion', () => {
    for (const r of pv.rows.filter((x) => x.category === 'known_gap')) {
      expect(r.note.length, r.id).toBeGreaterThan(10);
      expect(r.expected, r.id).toEqual([]);
      expect(r.leaks, r.id).toBeTruthy();
    }
    for (const r of [...el.rows, ...ur.rows].filter((x) => x.knownGap || x.category === 'known_gap')) {
      expect(r.note.length, r.id).toBeGreaterThan(10);
      expect(r.knownGap, r.id).toBe(true);
    }
  });
});

describe('adversarial privacy rows', () => {
  it.each(pv.rows.map((r) => [r.id, r.category, r] as const))('%s (%s)', (id, _c, row) => {
    const flags = detectPrivacyFlags(row.text);
    if (row.category === 'known_gap') {
      // Current behaviour: the identifier is NOT covered. An improvement fails here on purpose
      // so the row is moved out of known_gap deliberately.
      expect(covered(row.text, flags, row.leaks!), `${id} gap now closed, move the row`).toBe(false);
      return;
    }
    for (const e of row.expected) {
      expect(covered(row.text, flags, e.covers, e.kind), `${id} missed ${e.kind}`).toBe(true);
    }
    if (row.expected.length === 0) expect(flags, `${id} should be clean`).toEqual([]);
    for (const f of flags) {
      expect(f.start, id).toBeGreaterThanOrEqual(0);
      expect(f.end, id).toBeLessThanOrEqual(row.text.length);
      expect(f.end, id).toBeGreaterThan(f.start);
    }
  });
});

describe('adversarial eligibility rows', () => {
  it.each(el.rows.map((r) => [r.id, r.category, r] as const))('%s (%s)', (id, _c, row) => {
    const got = classifyStatement(row.text);
    if (row.expected === 'accepted') expect(got, id).toEqual({ ok: true });
    else expect(got, id).toMatchObject({ ok: false, ineligibilityCode: row.expected, ruleId: row.ruleId });
  });
});

describe('adversarial url rows', () => {
  it.each(ur.rows.map((r) => [r.id, r.category, r] as const))('%s (%s)', (id, _c, row) => {
    expect(checkEvidenceUrl(row.url), id).toMatchObject(row.expected);
  });
});

describe('adversarial performance', () => {
  // Regex backtracking guard: 100000 characters of hostile repetition, every detector under 200 ms.
  const units = [
    '1 O ', '1 O O O ', '0 ', 'Aa ', 'a@a.a.', 'a.', '1-', '(', 'x', 'dana at ', 'Dana ', '12 Elm ', 'one ',
    'ABC ', 'password ', '1 l ', '​', '́', '[at] ', '555 ', '-----BEGIN ', 'Mr ', 'I ',
  ];
  it.each(units.map((u) => [JSON.stringify(u), u] as const))('unit %s stays linear', (_n, u) => {
    const text = u.repeat(Math.ceil(100000 / u.length)).slice(0, 100000);
    for (const run of [detectPrivacyFlags, classifyStatement, findSecrets, checkEvidenceUrl] as ((t: string) => unknown)[]) {
      const t0 = performance.now();
      run(text);
      expect(performance.now() - t0, run.name).toBeLessThan(200);
    }
  });
});

const rulesPath = resolve(process.cwd(), '../docs/spec/constitution/rules.md');
describe.skipIf(!existsSync(rulesPath))(
  'adversarial rule ids exist in docs/spec/constitution/rules.md (skipped when the superproject docs are absent)',
  () => {
    it('every row cites a registered rule id', () => {
      const registry = readFileSync(rulesPath, 'utf8');
      const ids = new Set([...registry.matchAll(/^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*\|/gm)].map((m) => m[1]));
      for (const r of [...pv.rows, ...el.rows, ...ur.rows]) expect(ids.has(r.ruleId), `${r.id} ${r.ruleId}`).toBe(true);
    });
  },
);
