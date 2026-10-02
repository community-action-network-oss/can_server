// Stage level of lifecycle v2. Owner: docs/spec/01b-stages.md (4b.1 plan, 4b.2 states). Pure; no I/O.

export const STAGE_STATES = [
  'planned',
  'ready',
  'active',
  'resolving',
  'resolved',
  'blocked',
  'skipped',
] as const;
export type StageState = (typeof STAGE_STATES)[number];

export const DECISION_METHODS = [
  'poster_after_input',
  'community_vote',
  'steward',
  'other_named',
] as const;
export type DecisionMethod = (typeof DECISION_METHODS)[number];

export interface Criterion {
  id: string;
  statement: string;
  measure: string;
  target?: string;
  evidenceHint?: string;
}

export interface Stage {
  id: string;
  name: string;
  goal: string;
  decisionMethod: DecisionMethod;
  required: boolean;
  needsChoice: boolean;
  autoStart: boolean;
  /** Stage ids that must be resolved or skipped first. */
  dependsOn: string[];
  criteria: Criterion[];
}

export interface StagePlan {
  planVersion: number;
  stages: Stage[];
  /** What "solved" means; separate from stage criteria (CRITERIA-1). */
  finalCriteria: Criterion[];
}

export type StageStates = Record<string, StageState>;

/** Exact chip text, 01b section 4b.2. */
export const STAGE_CHIP: Record<StageState, string> = {
  planned: 'Planned',
  ready: 'Ready',
  active: 'In progress',
  resolving: 'Checking evidence',
  resolved: 'Done',
  blocked: 'Blocked',
  skipped: 'Skipped',
};
