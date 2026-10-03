import type { EventKind, PriorityClass } from '../domain/selector/events.js';
import type { Trigger } from '../domain/run-key.js';

/** Domain event names of cross-cutting.md. */
export const MODERATION_RUN_COMPLETED = 'moderation.run.completed';
export const MODERATION_HELD = 'moderation.held';
export const POLICY_VERSION_RATIFIED = 'policy.version.ratified';

export const MODERATION_QUEUE = 'moderation';

export type RelaySource = 'problem_event' | 'stage_event' | 'moderation_event';

/**
 * A moderation job. Ids, codes and field names only: never user text or personal data.
 * Handlers process jobs of one target in `targetVersion` order (triggers.md "Ordering and concurrency").
 */
export interface ModerationJob {
  v: 1;
  kind: 'dp' | 'policy_fanout';
  source: RelaySource;
  eventId: string;
  eventKind: EventKind;
  trigger: Trigger;
  priorityClass: PriorityClass;
  dpId?: string;
  mode?: 'blocking' | 'async';
  fields?: readonly string[];
  reusePrior?: readonly string[];
  targetKind?: string;
  targetId?: string;
  targetVersion?: number;
  jurisdictionId?: string | null;
  /** The pack has no section for this DP: the handler holds with this reason, it never skips. */
  holdReason?: 'pack_missing';
  stageIds?: readonly string[];
  fromVersion?: string;
  toVersion?: string;
  scope?: string;
  windowId?: string;
}

export const TRIGGER_BY_EVENT: Record<EventKind, Trigger> = {
  review_requested: 'submit_gate',
  publication_requested: 'publish',
  edited: 'update',
  contribution_submitted: 'review',
  stage_option_ready: 'review',
  stage_choice_recorded: 'review',
  stage_evidence_submitted: 'stage_evidence',
  plan_change_proposed: 'plan_change',
  recommendation_submitted: 'review',
  stuck_proposed: 'review',
  close_proposed: 'review',
  solved_proposed: 'review',
  problem_ended: 'update',
  suggestion_requested: 'advisory',
  stage_draft_requested: 'advisory',
  appeal_filed: 'appeal',
  policy_changed: 'policy_change',
  context_changed: 'context_change',
  sample_tick: 'sample',
};

export interface Mapped {
  kind: EventKind;
  changedFields?: string[];
  /** The job targets the contribution named in the payload (`contributionId`), not the problem. */
  target?: 'contribution';
}

const FIELD = /^[a-z][a-zA-Z0-9_]{0,63}$/;

/** problem_event type (plus payload) to a selector event kind. Unknown types are null: the relay counts and ignores them. */
export function mapProblemEvent(
  type: string,
  payload: Record<string, unknown> | null,
): Mapped | null {
  const tid = payload?.transitionId;
  switch (type) {
    case 'state_changed':
      return tid === 'T01' || tid === 'T03'
        ? { kind: 'review_requested' }
        : null;
    case 'transition_proposed':
      return tid === 'T04' ? { kind: 'publication_requested' } : null;
    case 'publication_requested':
      return { kind: 'publication_requested' };
    case 'contribution.submitted':
      return { kind: 'contribution_submitted', target: 'contribution' };
    case 'contribution.edited':
      return { kind: 'edited', target: 'contribution' };
    case 'problem.stuck_candidate':
      return { kind: 'stuck_proposed' };
    case 'problem.edited': {
      const f = payload?.changedFields;
      return {
        kind: 'edited',
        changedFields: Array.isArray(f)
          ? f.filter((x): x is string => typeof x === 'string' && FIELD.test(x))
          : [],
      };
    }
    default:
      return null;
  }
}

/** stage_event type to a selector event kind. */
export function mapStageEvent(type: string): Mapped | null {
  return type === 'resolution_queued'
    ? { kind: 'stage_evidence_submitted' }
    : null;
}
