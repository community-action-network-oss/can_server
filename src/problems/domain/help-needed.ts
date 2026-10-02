// help_needed (spec 26 section 5, D-80): describes a problem, never a person. Pure; no I/O.

/** Plain-language groups from spec 26 section 2. Packs may extend via `extraGroups` (OQ-capability-taxonomy default). */
export const SKILL_GROUPS = [
  'care_and_health',
  'hospitality_and_food',
  'public_service_and_administration',
  'trades_and_repair',
  'law_and_rights',
  'teaching_and_childcare',
  'transport',
  'technology',
  'research',
  'community_organising',
] as const;

export interface HelpNeeded {
  skill_groups: string[];
  languages: string[];
  /** Coarse area id only. Null when no place applies. */
  coarse_place: string | null;
  topics: string[];
}

export const EMPTY_HELP_NEEDED: HelpNeeded = {
  skill_groups: [],
  languages: [],
  coarse_place: null,
  topics: [],
};

const SLUG = /^[a-z][a-z0-9_]{0,63}$/;
const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const MAX_ITEMS = 12;

export interface HelpNeededIssue {
  field: keyof HelpNeeded;
  message: string;
}

/**
 * Shape check against the taxonomy. Issues are advisory: a wrong tag alone never blocks
 * publication (OQ-help-needed-tags default), so callers drop or flag, they do not refuse the problem.
 */
export function validateHelpNeeded(
  v: unknown,
  extraGroups: readonly string[] = [],
): { value: HelpNeeded; issues: HelpNeededIssue[] } {
  const issues: HelpNeededIssue[] = [];
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const list = (
    field: 'skill_groups' | 'languages' | 'topics',
    ok: (s: string) => boolean,
    why: string,
  ): string[] => {
    const raw = Array.isArray(o[field]) ? (o[field] as unknown[]) : [];
    const out: string[] = [];
    for (const x of raw) {
      if (typeof x === 'string' && ok(x)) {
        if (!out.includes(x)) out.push(x);
      } else issues.push({ field, message: why });
    }
    if (out.length > MAX_ITEMS) {
      issues.push({ field, message: `at most ${MAX_ITEMS} entries` });
      out.length = MAX_ITEMS;
    }
    return out.sort();
  };
  const groups = new Set<string>([...SKILL_GROUPS, ...extraGroups]);
  const cp = o.coarse_place;
  const coarse_place = typeof cp === 'string' && SLUG.test(cp) ? cp : null;
  if (cp != null && coarse_place === null)
    issues.push({ field: 'coarse_place', message: 'not a coarse area id' });
  return {
    value: {
      skill_groups: list('skill_groups', (s) => groups.has(s), 'unknown group'),
      languages: list('languages', (s) => BCP47.test(s), 'not a language tag'),
      coarse_place,
      topics: list('topics', (s) => SLUG.test(s), 'not a topic id'),
    },
    issues,
  };
}
