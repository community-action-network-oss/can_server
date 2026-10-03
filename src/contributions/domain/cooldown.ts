// Reflection delays (OQ-cooldown-lengths): change the values here only.
import type { ContributionType } from './types.js';

export const COOLDOWN: {
  betweenContributionsSeconds: number;
  afterRejectionSeconds: number;
  exemptTypes: readonly ContributionType[];
} = {
  betweenContributionsSeconds: 120,
  afterRejectionSeconds: 600,
  exemptTypes: ['progress_update', 'verification_evidence'],
};

/**
 * Earliest time one account may contribute again on one problem, or null if now is fine.
 * Reads COOLDOWN at call time, so tests and later pack-limit overrides can pass `cooldown`.
 */
export function nextAllowedAt(a: {
  now: Date;
  lastContributionAt: Date | null;
  lastRejectedAt: Date | null;
  type: ContributionType;
  cooldown?: typeof COOLDOWN;
}): Date | null {
  const c = a.cooldown ?? COOLDOWN;
  if (c.exemptTypes.includes(a.type)) return null;
  const candidates = [
    a.lastContributionAt &&
      a.lastContributionAt.getTime() + c.betweenContributionsSeconds * 1000,
    a.lastRejectedAt &&
      a.lastRejectedAt.getTime() + c.afterRejectionSeconds * 1000,
  ].filter((x): x is number => typeof x === 'number');
  if (!candidates.length) return null;
  const at = Math.max(...candidates);
  return at > a.now.getTime() ? new Date(at) : null;
}
