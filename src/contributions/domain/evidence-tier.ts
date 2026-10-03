// EVIDENCE-TIERS (constitution III.4). Deterministic floor from URL categories; DP-EVIDENCE-TIER may override.
export const TIER_MAX_DETERMINISTIC = 4;

/** Tier of one cited URL by category. Tiers 5 and 6 need a run or verification, never a URL category alone. */
export const tierOfKind = (kind: string): number =>
  kind === 'official_page' ? 4 : kind === 'news' ? 3 : 2;

/** Problem tier from the categories of every public, non-verification evidence ref. No refs: 1 (unverified signal). */
export const recomputeEvidenceTier = (kinds: readonly string[]): number =>
  Math.max(1, ...kinds.map(tierOfKind));

/** D-30 / III.4: tiers 1 and 2 need investigation. Always derived, never set by hand. */
export const investigationNeeded = (tier: number): boolean => tier <= 2;
