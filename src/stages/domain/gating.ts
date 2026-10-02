// Stage gating (01b 4b.4, STAGE-GATE-1). Pure functions over a plan and the current stage states.
//
// T22 (PLAN-CHANGE) callers: the lifecycle table defers stage graph and criteria checks to DP-STAGE-PLAN.
// Those checks live here and in plan.ts. After building the changed plan, call validatePlan(newPlan) and
// refuse the change when !ok. After applying the stage effects (ST01, ST09, ST10, ST11) call readyStages
// (newPlan, states) for the new ST02 set, successorsAfterReopen for ST10 effects, and finalCheckDue to
// decide whether T15 is requested again.
import type { ActiveStages } from '../../domain/lifecycle/vocabulary.js';
import type { StagePlan, StageState, StageStates } from './types.js';

/** Resolved or skipped: a skipped stage counts as resolved for gating. */
export const settled = (s: StageState | undefined) =>
  s === 'resolved' || s === 'skipped';

/** Planned stages whose every predecessor is settled. Each becomes ready by ST02, once. */
export function readyStages(plan: StagePlan, states: StageStates): string[] {
  return plan.stages
    .filter(
      (s) =>
        states[s.id] === 'planned' &&
        s.dependsOn.every((d) => settled(states[d])),
    )
    .map((s) => s.id);
}

export type CanStart = { ok: true } | { ok: false; code: 'not_ready' };

/** STAGE-GATE-1: only a `ready` stage may start (ST03). A planned stage gets not_ready. */
export function canStart(
  plan: StagePlan,
  states: StageStates,
  id: string,
): CanStart {
  const s = plan.stages.find((x) => x.id === id);
  return s &&
    states[id] === 'ready' &&
    s.dependsOn.every((d) => settled(states[d]))
    ? { ok: true }
    : { ok: false, code: 'not_ready' };
}

/** Every required stage resolved or skipped: the final check (T15) is requested. */
export function finalCheckDue(plan: StagePlan, states: StageStates): boolean {
  return plan.stages.every((s) => !s.required || settled(states[s.id]));
}

/** Data for the problem chip: stages in progress (active or resolving). null means plain "Active". */
export function problemChip(
  plan: StagePlan,
  states: StageStates,
): ActiveStages {
  const on = plan.stages.filter(
    (s) => states[s.id] === 'active' || states[s.id] === 'resolving',
  );
  if (on.length === 0) return null;
  return on.length === 1
    ? { kind: 'one', name: on[0].name }
    : { kind: 'many', n: on.length };
}

/** ST10: direct successors of a reopened stage that are still `ready` go back to `planned`. Started ones keep running. */
export function successorsAfterReopen(
  plan: StagePlan,
  states: StageStates,
  id: string,
): string[] {
  return plan.stages
    .filter((s) => s.dependsOn.includes(id) && states[s.id] === 'ready')
    .map((s) => s.id);
}
