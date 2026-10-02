// Stage plan validation (DP-STAGE-PLAN, CRITERIA-1) and ordering. Pure.
import type { StagePlan } from './types.js';

export type PlanIssue =
  | { code: 'cycle'; path: string[] }
  | { code: 'dangling_edge'; stageId: string; missing: string }
  | { code: 'no_start_node' }
  | { code: 'no_criteria'; stageId: string }
  | { code: 'no_final_criteria' }
  | { code: 'unreachable_from_final'; stageId: string }
  | { code: 'dead_end_required'; stageId: string }
  | { code: 'duplicate_name'; name: string };

const successorsOf = (plan: StagePlan) => {
  const ids = new Set(plan.stages.map((s) => s.id));
  const next = new Map<string, string[]>(plan.stages.map((s) => [s.id, []]));
  for (const s of plan.stages)
    for (const d of s.dependsOn) if (ids.has(d)) next.get(d)!.push(s.id);
  return next;
};

/** First cycle found (as a closed path a -> b -> a), or null. Ignores dangling edges. */
function findCycle(plan: StagePlan): string[] | null {
  const byId = new Map(plan.stages.map((s) => [s.id, s]));
  const color = new Map<string, 1 | 2>(); // 1 on stack, 2 done
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)!.dependsOn) {
      if (!byId.has(d)) continue;
      if (color.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!color.has(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const s of plan.stages)
    if (!color.has(s.id)) {
      const c = visit(s.id);
      if (c) return c;
    }
  return null;
}

export function validatePlan(plan: StagePlan): {
  ok: boolean;
  issues: PlanIssue[];
} {
  const issues: PlanIssue[] = [];
  const ids = new Set(plan.stages.map((s) => s.id));
  for (const s of plan.stages)
    for (const d of s.dependsOn)
      if (!ids.has(d))
        issues.push({ code: 'dangling_edge', stageId: s.id, missing: d });
  const cycle = findCycle(plan);
  if (cycle) issues.push({ code: 'cycle', path: cycle });
  if (
    plan.stages.length > 0 &&
    !plan.stages.some((s) => s.dependsOn.length === 0)
  )
    issues.push({ code: 'no_start_node' });
  for (const s of plan.stages)
    if (s.criteria.length === 0)
      issues.push({ code: 'no_criteria', stageId: s.id });
  if (plan.finalCriteria.length === 0)
    issues.push({ code: 'no_final_criteria' });
  const seen = new Set<string>();
  for (const s of plan.stages) {
    const n = s.name.trim().toLowerCase();
    if (seen.has(n)) issues.push({ code: 'duplicate_name', name: s.name });
    seen.add(n);
  }
  // ponytail: the plan has no stage-to-final-criterion mapping, so a required sink is taken to serve the
  // final criteria whenever any exist; upgrade if a servesFinal field is added to Stage.
  // unreachable_from_final: a required stage whose every path ends only in non-required sinks.
  const next = successorsOf(plan);
  const byId = new Map(plan.stages.map((s) => [s.id, s]));
  const reachesRequiredSink = new Map<string, boolean>();
  const reach = (id: string, guard: Set<string>): boolean => {
    if (reachesRequiredSink.has(id)) return reachesRequiredSink.get(id)!;
    if (guard.has(id)) return false; // cycle already reported
    guard.add(id);
    const out = next.get(id)!;
    const r =
      out.length === 0
        ? byId.get(id)!.required
        : out.some((o) => reach(o, guard));
    guard.delete(id);
    reachesRequiredSink.set(id, r);
    return r;
  };
  for (const s of plan.stages) {
    if (!s.required) continue;
    if (!reach(s.id, new Set()))
      issues.push({ code: 'unreachable_from_final', stageId: s.id });
  }
  // dead_end_required: a required sink with no final criterion to serve.
  for (const s of plan.stages)
    if (
      s.required &&
      next.get(s.id)!.length === 0 &&
      plan.finalCriteria.length === 0
    )
      issues.push({ code: 'dead_end_required', stageId: s.id });
  return { ok: issues.length === 0, issues };
}

/** Stages ordered so every stage follows the stages it starts after. Ties keep plan order. Throws on a cycle. */
export function topoOrder(plan: StagePlan): string[] {
  const ids = new Set(plan.stages.map((s) => s.id));
  const left = new Map(
    plan.stages.map((s) => [
      s.id,
      s.dependsOn.filter((d) => ids.has(d)).length,
    ]),
  );
  const next = successorsOf(plan);
  const out: string[] = [];
  const queue = plan.stages
    .filter((s) => left.get(s.id) === 0)
    .map((s) => s.id);
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const n of next.get(id)!) {
      left.set(n, left.get(n)! - 1);
      if (left.get(n) === 0) queue.push(n);
    }
  }
  if (out.length !== plan.stages.length)
    throw new Error('stage plan has a cycle');
  return out;
}
