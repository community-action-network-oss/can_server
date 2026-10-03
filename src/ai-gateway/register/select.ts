import type { DpEval, ModelEntry } from './model-register.js';

export const FAKE_EVAL_PREFIX = 'fake-derived-';

/** A fake recording is never evidence (can_policy fake_recordings_satisfy: false). */
export const isFakeEval = (entry: ModelEntry, d: DpEval): boolean =>
  (d.modelId ?? entry.id).startsWith(FAKE_EVAL_PREFIX);

/** Production-selectable for a DP: live provider, current eval, and a passing non-fake result for that DP. */
export function selectableForDp(
  entry: ModelEntry,
  dpId: string,
  now: Date,
): boolean {
  if (entry.provider === 'fake') return false;
  if (!entry.evalExpiry || Date.parse(entry.evalExpiry) <= now.getTime())
    return false;
  if (!entry.dpEligibility.includes(dpId) && !entry.dpEligibility.includes('*'))
    return false;
  return (entry.perDp ?? []).some(
    (d) => d.dpId === dpId && d.passed && !isFakeEval(entry, d),
  );
}

export interface DpSelection {
  primary: string | null;
  fallbacks: string[];
}

/** Free first, then ascending price, id as tiebreak. No eligible model: primary null, the router holds. */
export function selectForDp(
  register: readonly ModelEntry[],
  dpId: string,
  now: Date,
  maxFallbacks = 3,
): DpSelection {
  const price = (e: ModelEntry) => e.costPerMtok.in + e.costPerMtok.out;
  const ids = register
    .filter((e) => selectableForDp(e, dpId, now))
    .sort(
      (a, b) =>
        Number(b.free) - Number(a.free) ||
        price(a) - price(b) ||
        a.id.localeCompare(b.id),
    )
    .map((e) => e.id);
  return { primary: ids[0] ?? null, fallbacks: ids.slice(1, 1 + maxFallbacks) };
}
