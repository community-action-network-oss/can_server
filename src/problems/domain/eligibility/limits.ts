export const LIMITS = {
  title: 120, condition: 300, affected: 300, desiredOutcome: 300, observed: 600, uncertain: 600,
} as const;
export type LimitField = keyof typeof LIMITS;

export interface LimitViolation { field: LimitField; max: number; length: number }

/** Length in code points. Unknown or missing fields are ignored. */
export function checkLimits(fields: Partial<Record<LimitField, string>>): { ok: boolean; violations: LimitViolation[] } {
  const violations: LimitViolation[] = [];
  for (const field of Object.keys(LIMITS) as LimitField[]) {
    const v = fields[field];
    if (v === undefined) continue;
    const length = Array.from(v).length;
    if (length > LIMITS[field]) violations.push({ field, max: LIMITS[field], length });
  }
  return { ok: violations.length === 0, violations };
}
