import type { StageStates } from '../domain/types.js';
import type { PlanDraft } from './plan-wire.js';
import type { stage as stageTable } from '../../db/schema.js';

export type StageRow = typeof stageTable.$inferSelect;
export interface LoadedPlan {
  /** Ids are database ids; Stage.name is the label. */
  plan: PlanDraft;
  states: StageStates;
  rows: StageRow[];
  problem: {
    id: string;
    state: string;
    initiatorId: string | null;
    planVersion: number;
  };
}

export interface StagePlanRepository {
  /** Replaces the draft plan atomically; only while the problem is draft or needs_revision. validatePlan runs first. */
  savePlan(problemId: string, plan: PlanDraft): Promise<void>;
  /** No visibility rule: for server-side callers. */
  loadPlan(problemId: string): Promise<LoadedPlan | null>;
  /** null when the viewer may not see the problem (private to anyone but the poster). */
  listForViewer(
    problemId: string,
    viewerId: string | null,
  ): Promise<LoadedPlan | null>;
}
export const STAGE_PLAN_REPO = Symbol('StagePlanRepository');
