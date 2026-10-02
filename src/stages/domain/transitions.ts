// Stage transition table ST01 to ST11: executable form of docs/spec/01b-stages.md section 4b.3.
// transitions.spec.ts parses that file and fails on drift. Pure; no I/O.
import type { State } from '../../domain/lifecycle/vocabulary.js';
import type { StagePlan, StageState, StageStates } from './types.js';
import { settled, successorsAfterReopen } from './gating.js';

export type StageActor = 'steward' | 'run' | 'system';
export type StageCondition =
  | 'problemActive'
  | 'predecessorsResolved'
  | 'choiceRecorded'
  | 'tasksDone'
  | 'evidenceMapped';

export interface StageTransition {
  id: `ST${string}`;
  from: readonly (StageState | 'none')[];
  /** `prior` (ST08): the state before the block, ready or active. */
  to: StageState | 'prior';
  actors: readonly StageActor[];
  required: readonly string[];
  conditions: readonly StageCondition[];
}

const BLOCK = [
  'blocker',
  'source',
  'sourceVersion',
  'blockedActions',
  'recheckCondition',
  'nextRoute',
  'attempts',
] as const;
const RESULT = ['ruleIds', 'criterionResults', 'policyVersion'] as const;

export const STAGE_TRANSITIONS: readonly StageTransition[] = [
  {
    id: 'ST01',
    from: ['none'],
    to: 'planned',
    actors: ['system'],
    required: ['name', 'goal', 'criteria', 'decisionMethod'],
    conditions: [],
  },
  {
    id: 'ST02',
    from: ['planned'],
    to: 'ready',
    actors: ['system'],
    required: [],
    conditions: ['predecessorsResolved'],
  },
  {
    id: 'ST03',
    from: ['ready'],
    to: 'active',
    actors: ['steward', 'system'],
    required: [],
    conditions: ['problemActive'],
  },
  {
    id: 'ST04',
    from: ['active'],
    to: 'resolving',
    actors: ['steward'],
    required: [],
    conditions: ['choiceRecorded', 'tasksDone', 'evidenceMapped'],
  },
  {
    id: 'ST05',
    from: ['resolving'],
    to: 'resolved',
    actors: ['run'],
    required: RESULT,
    conditions: ['problemActive'],
  },
  {
    id: 'ST06',
    from: ['resolving'],
    to: 'active',
    actors: ['run'],
    required: RESULT,
    conditions: [],
  },
  {
    id: 'ST07',
    from: ['ready', 'active', 'resolving'],
    to: 'blocked',
    actors: ['steward', 'run'],
    required: BLOCK,
    conditions: [],
  },
  {
    id: 'ST08',
    from: ['blocked'],
    to: 'prior',
    actors: ['steward', 'run'],
    required: ['clearedNote', 'evidence'],
    conditions: [],
  },
  {
    id: 'ST09',
    from: ['planned', 'ready', 'active', 'blocked'],
    to: 'skipped',
    actors: ['run', 'system'],
    required: ['reason'],
    conditions: [],
  },
  {
    id: 'ST10',
    from: ['resolved'],
    to: 'active',
    actors: ['run'],
    required: ['reason', 'criteriaAffected'],
    conditions: [],
  },
  {
    id: 'ST11',
    from: ['skipped'],
    to: 'planned',
    actors: ['run'],
    required: ['reason'],
    conditions: [],
  },
];

export interface StageGuardContext {
  /** Problem-level state. While paused or stuck no stage starts or resolves. */
  problemState?: State;
  predecessorsResolved?: boolean;
  /** Callers pass true when the stage has needsChoice false. */
  choiceRecorded?: boolean;
  tasksDone?: boolean;
  evidenceMapped?: boolean;
  /** ST03 by the system needs the stage's autoStart. */
  autoStart?: boolean;
  /** ST08: the state before the block. */
  priorState?: 'ready' | 'active';
  /** Actor `run` needs a recorded run id. */
  runId?: string;
}

export type StageGuardResult =
  | { ok: true; transition: StageTransition }
  | {
      ok: false;
      code:
        | 'invalid_transition'
        | 'not_permitted'
        | 'missing_fields'
        | 'condition_failed';
      missing?: string[];
      transitionId?: string;
    };

const has = (v: unknown) =>
  v !== undefined &&
  v !== null &&
  v !== '' &&
  !(Array.isArray(v) && v.length === 0);

export function evaluateStageTransition(i: {
  from: StageState | 'none';
  to: StageState;
  actor: StageActor;
  fields?: Readonly<Record<string, unknown>>;
  context?: StageGuardContext;
}): StageGuardResult {
  const ctx = i.context ?? {};
  const t = STAGE_TRANSITIONS.find(
    (r) =>
      r.from.includes(i.from) &&
      (r.to === 'prior'
        ? (i.to === 'ready' || i.to === 'active') && ctx.priorState === i.to
        : r.to === i.to),
  );
  if (!t) return { ok: false, code: 'invalid_transition' };
  const id = t.id;
  if (
    !t.actors.includes(i.actor) ||
    (i.actor === 'run' && !ctx.runId) ||
    (id === 'ST03' && i.actor === 'system' && ctx.autoStart !== true)
  )
    return { ok: false, code: 'not_permitted', transitionId: id };
  const missing = t.required.filter((k) => !has(i.fields?.[k]));
  if (missing.length)
    return { ok: false, code: 'missing_fields', missing, transitionId: id };
  const holds: Record<StageCondition, boolean> = {
    problemActive: ctx.problemState === 'active',
    predecessorsResolved: ctx.predecessorsResolved === true,
    choiceRecorded: ctx.choiceRecorded === true,
    tasksDone: ctx.tasksDone === true,
    evidenceMapped: ctx.evidenceMapped === true,
  };
  if (t.conditions.some((c) => !holds[c]))
    return { ok: false, code: 'condition_failed', transitionId: id };
  return { ok: true, transition: t };
}

/** Convenience for ST02 callers: does the plan say this stage's predecessors are settled? */
export const predecessorsResolved = (
  plan: StagePlan,
  states: StageStates,
  id: string,
) =>
  plan.stages
    .find((s) => s.id === id)
    ?.dependsOn.every((d) => settled(states[d])) ?? false;

export { successorsAfterReopen };
