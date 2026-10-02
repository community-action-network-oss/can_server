/** Selector vocabulary (triggers.md, lifecycle v2). Pure: no Nest, no I/O. */

/** Closed event union. The old submitted, resubmitted, proposal_ready, decision_record_submitted, evidence_added and stage_move_proposed are gone. */
export const EVENT_KINDS = [
  'review_requested',
  'publication_requested',
  'edited',
  'contribution_submitted',
  'stage_option_ready',
  'stage_choice_recorded',
  'stage_evidence_submitted',
  'plan_change_proposed',
  'recommendation_submitted',
  'stuck_proposed',
  'close_proposed',
  'solved_proposed',
  'problem_ended',
  'suggestion_requested',
  'stage_draft_requested',
  'appeal_filed',
  'policy_changed',
  'context_changed',
  'sample_tick',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The target kinds of the decision-points.md matrix. The selector's "target kind" is this. */
export const CONTENT_TYPES = [
  'problem',
  'contribution',
  'proposal',
  'decision_record',
  'task_verification',
  'appeal',
  'policy_proposal',
  'stage',
  'stage_option',
  'stage_choice',
  'stage_evidence',
  'review_recommendation',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export type DpMode = 'blocking' | 'async';
/** Same names as the job classes of the queue (platform/queue). */
export type PriorityClass = 'crisis' | 'prepub' | 'update' | 'async' | 'sample';

/** Events that carry user text, so the always-on DPs apply. */
export const TEXT_EVENTS: readonly EventKind[] = [
  'review_requested',
  'publication_requested',
  'edited',
  'contribution_submitted',
  'stage_option_ready',
  'stage_choice_recorded',
  'stage_evidence_submitted',
  'plan_change_proposed',
  'recommendation_submitted',
  'stuck_proposed',
  'close_proposed',
  'solved_proposed',
  'appeal_filed',
];
