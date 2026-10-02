// Preparation readiness (12-u04, D-72 step 1). Pure. Pointers are JSON pointers into the draft content, which stays snake_case (D-82).
import { validatePlan, type PlanIssue } from '../../stages/domain/plan.js';
import {
  planFromWire,
  type WireFinalCriterion,
  type WireStageNode,
} from '../../stages/app/plan-wire.js';

export const PARTS = ['facts', 'sources', 'criteria', 'stages'] as const;
export type Part = (typeof PARTS)[number];
export type Errors = Record<string, string>;

const PREFIX: Record<Exclude<Part, 'facts'>, string> = {
  sources: '/sources',
  criteria: '/final_acceptance_criteria',
  stages: '/stage_plan',
};
const under = (p: string, prefix: string) =>
  p === prefix || p.startsWith(`${prefix}/`);

/** Which readiness part a content pointer or a plain column belongs to. */
export function partOf(pointer: string): Part {
  for (const k of Object.keys(PREFIX) as (keyof typeof PREFIX)[])
    if (under(pointer, PREFIX[k])) return k;
  return 'facts';
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** Sources must be https (the schema pattern also allows http). */
export function insecureSources(sources: unknown): Errors {
  const out: Errors = {};
  arr(sources).forEach((s, i) => {
    const uri = rec(s).uri;
    if (typeof uri === 'string' && !uri.startsWith('https://'))
      out[`/sources/${i}/uri`] = 'Use a secure https link.';
  });
  return out;
}

const MSG: Record<PlanIssue['code'], string> = {
  cycle: 'The stages depend on each other in a loop.',
  dangling_edge: 'This points at a stage that is not in the plan.',
  no_start_node: 'At least one stage must have nothing before it.',
  no_criteria: 'Every stage needs at least one acceptance criterion.',
  no_final_criteria: 'Add the final acceptance criteria first.',
  unreachable_from_final: 'This required stage leads nowhere that counts.',
  dead_end_required: 'This required stage serves no final criterion.',
  duplicate_name: 'Two stages share a name.',
};

/** Plan issues as content pointers. Stage nodes are identified by `name`. */
export function planErrors(issues: PlanIssue[], nodes: unknown[]): Errors {
  const ptr = (name: string, tail: string) => {
    const i = nodes.findIndex(
      (n) => rec(n).name === name || rec(n).label === name,
    );
    return i < 0 ? '/stage_plan' : `/stage_plan/${i}${tail}`;
  };
  const out: Errors = {};
  for (const i of issues) {
    const key =
      i.code === 'dangling_edge'
        ? ptr(i.stageId, '/depends_on')
        : i.code === 'no_criteria'
          ? ptr(i.stageId, '/acceptance_criteria')
          : i.code === 'unreachable_from_final' ||
              i.code === 'dead_end_required'
            ? ptr(i.stageId, '')
            : i.code === 'duplicate_name'
              ? ptr(i.name, '/name')
              : i.code === 'cycle'
                ? ptr(i.path[0], '/depends_on')
                : '/stage_plan';
    out[key] ??= MSG[i.code];
  }
  return out;
}

/** The DP-STAGE-PLAN checks that need no schema: DAG, coherence, criteria on every stage. Empty when there is no plan. */
export function checkPlan(content: Record<string, unknown>): {
  issues: PlanIssue[];
  errors: Errors;
} {
  const nodes = arr(content.stage_plan);
  if (!nodes.length) return { issues: [], errors: {} };
  const plan = planFromWire(
    nodes as WireStageNode[],
    arr(content.final_acceptance_criteria) as WireFinalCriterion[],
  );
  const { issues } = validatePlan(plan);
  return { issues, errors: planErrors(issues, nodes) };
}

/** CRITERIA-1 and SOURCE-1 presence, for drafts that have no schema stamp to check against. */
export function presence(
  content: Record<string, unknown>,
  noSourceNote: string | null,
): Errors {
  const out: Errors = {};
  if (!arr(content.sources).length && !noSourceNote)
    out['/sources'] = 'Add a source or say that you have none yet.';
  if (!arr(content.final_acceptance_criteria).length)
    out['/final_acceptance_criteria'] =
      'Add at least one acceptance criterion.';
  return out;
}

export interface Readiness {
  status: 'ready' | 'not_finished';
  /** A code, never copy: missing | invalid | needs_evidence | default_plan. */
  reason: string | null;
  fieldErrors: Errors;
}

/** Per-part readiness from the merged field errors. */
export function readiness(
  errors: Errors,
  content: Record<string, unknown>,
  noSourceNote: string | null,
): Record<Part, Readiness> & { ready: boolean } {
  const by: Record<Part, Errors> = {
    facts: {},
    sources: {},
    criteria: {},
    stages: {},
  };
  for (const [p, m] of Object.entries(errors)) by[partOf(p)][p] = m;
  const part = (k: Part, whenOk: string | null, whenBad = 'invalid') => {
    const fieldErrors = by[k];
    const bad = Object.keys(fieldErrors).length > 0;
    return {
      status: bad ? 'not_finished' : 'ready',
      reason: bad ? whenBad : whenOk,
      fieldErrors,
    } as Readiness;
  };
  const noSource = !arr(content.sources).length && !!noSourceNote;
  const out = {
    facts: part('facts', null, 'incomplete'),
    sources: part('sources', noSource ? 'needs_evidence' : null),
    criteria: part('criteria', null),
    stages: part(
      'stages',
      arr(content.stage_plan).length ? null : 'default_plan',
    ),
  };
  return { ...out, ready: PARTS.every((k) => out[k].status === 'ready') };
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Recommendation paths (review_recommendation.path) whose content changed. */
export function changedPaths(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[k], after[k])) continue;
    out.push(k);
    if (k !== 'stage_plan') continue;
    const byName = (v: unknown) =>
      new Map(arr(v).map((n) => [String(rec(n).name), rec(n)]));
    const a = byName(before[k]);
    const b = byName(after[k]);
    for (const n of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(n);
      const y = b.get(n);
      if (same(x, y)) continue;
      out.push(`stage_plan.${n}`);
      if (!same(x?.acceptance_criteria, y?.acceptance_criteria))
        out.push(`stage_plan.${n}.criteria`);
    }
  }
  return out;
}
