import { describe, expect, it } from 'vitest';
import { DEFAULT_REGISTER, parseRegister } from './model-register.js';
import type { DpEval, ModelEntry } from './model-register.js';
import { selectForDp, selectableForDp } from './select.js';

const now = new Date('2026-10-03T00:00:00Z');
const ev = (dpId: string, o: Partial<DpEval> = {}): DpEval => ({
  dpId,
  evalScore: 0.9,
  evalSetVersion: 'v1',
  evalDate: '2026-10-01',
  passed: true,
  ...o,
});
const m = (id: string, o: Partial<ModelEntry> = {}): ModelEntry => ({
  ...DEFAULT_REGISTER[0],
  id,
  provider: 'openrouter',
  free: false,
  costPerMtok: { in: 1, out: 1 },
  evalExpiry: '2027-01-01',
  dpEligibility: ['*'],
  perDp: [ev('dp1')],
  ...o,
});

describe('selectForDp', () => {
  it('free first, then cheapest; others become fallbacks', () => {
    const r = [
      m('dear', { costPerMtok: { in: 5, out: 5 } }),
      m('cheap'),
      m('free', { free: true, costPerMtok: { in: 0, out: 0 } }),
    ];
    expect(selectForDp(r, 'dp1', now)).toEqual({
      primary: 'free',
      fallbacks: ['cheap', 'dear'],
    });
  });
  it('fake-derived evidence never counts, by result or by entry id', () => {
    const r = [
      m('a', { perDp: [ev('dp1', { modelId: 'fake-derived-1' })] }),
      m('fake-derived-b'),
    ];
    expect(selectForDp(r, 'dp1', now).primary).toBeNull();
  });
  it('fake-1 and entries with no evidence are not selectable', () => {
    expect(selectableForDp(DEFAULT_REGISTER[0], 'dp1', now)).toBe(false);
    expect(selectableForDp(m('x', { perDp: [] }), 'dp1', now)).toBe(false);
    expect(selectableForDp(m('x', { perDp: undefined }), 'dp1', now)).toBe(
      false,
    );
  });
  it('expired eval, failed result and other-DP evidence hold', () => {
    expect(
      selectForDp([m('e', { evalExpiry: '2026-10-03' })], 'dp1', now).primary,
    ).toBeNull();
    expect(
      selectForDp(
        [m('f', { perDp: [ev('dp1', { passed: false })] })],
        'dp1',
        now,
      ).primary,
    ).toBeNull();
    expect(selectForDp([m('g')], 'dp2', now).primary).toBeNull();
  });
  it('parseRegister validates perDp', () => {
    expect(parseRegister([m('ok')])).toHaveLength(1);
    expect(() =>
      parseRegister([m('bad', { perDp: [{ dpId: 1 }] as never })]),
    ).toThrow(/invalid_register/);
  });
});
