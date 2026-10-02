// Contribution types allowed per stage state (01b 4b.6, STAGE-PREP-1) and per problem state. Pure.
import type { State } from '../../domain/lifecycle/vocabulary.js';
import type { StageState } from './types.js';

// The enum of docs/spec/01-slice-1-brief.md section 6.
export const CONTRIBUTION_TYPES = [
  'clarifying_question',
  'observation',
  'personal_experience',
  'factual_claim',
  'evidence',
  'interpretation',
  'root_cause',
  'constraint',
  'stakeholder_perspective',
  'proposed_solution',
  'proposal_improvement',
  'risk',
  'implementation_offer',
  'progress_update',
  'verification_evidence',
  'moderation_feedback',
] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];

const AHEAD: readonly ContributionType[] = [
  'clarifying_question',
  'observation',
  'evidence',
  'constraint',
  'risk',
  'stakeholder_perspective',
  'proposed_solution',
  'proposal_improvement',
  'implementation_offer',
];

const BY_STAGE: Record<StageState, readonly ContributionType[]> = {
  planned: AHEAD,
  ready: AHEAD,
  active: CONTRIBUTION_TYPES,
  resolving: ['clarifying_question', 'risk'],
  blocked: ['clarifying_question', 'progress_update', 'evidence', 'constraint'],
  resolved: [],
  skipped: [],
};

export const allowedContributionTypes = (s: StageState) => BY_STAGE[s];

/** Contributions that target no stage follow the problem state. */
export function allowedForProblemLevel(p: State): readonly ContributionType[] {
  if (p === 'active') return CONTRIBUTION_TYPES;
  if (p === 'paused' || p === 'stuck')
    return ['clarifying_question', 'progress_update'];
  return [];
}
