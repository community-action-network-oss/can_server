// Which contribution types a target accepts (01b 4b.6, STAGE-PREP-1). Pure.
import type { State } from '../../domain/lifecycle/vocabulary.js';
import {
  allowedContributionTypes,
  allowedForProblemLevel,
} from '../../stages/domain/contribution-matrix.js';
import type { StageState } from '../../stages/domain/types.js';
import { USER_TYPES, type ContributionType } from './types.js';

export interface Target {
  problemState: State;
  /** null: the contribution targets the whole problem. */
  stageState: StageState | null;
}

/** Types a person may submit to this target (moderation_feedback is reserved, so never listed). */
export function allowedTypes({
  problemState,
  stageState,
}: Target): readonly ContributionType[] {
  // A stage target is only open while the problem is running or paused/stuck-free; pre-publication and terminal states take nothing.
  const raw =
    stageState === null
      ? allowedForProblemLevel(problemState)
      : problemState === 'active'
        ? allowedContributionTypes(stageState)
        : [];
  return raw.filter((t) => USER_TYPES.includes(t));
}

export const isAllowed = (t: Target & { type: ContributionType }) =>
  allowedTypes(t).includes(t.type);

/** STAGE-PREP-1: true when the stage has not started, so the contribution is stored "for a later stage". */
export const isForLaterStage = (s: StageState | null) =>
  s === 'planned' || s === 'ready';
