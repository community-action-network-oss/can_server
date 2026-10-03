import { STAGE_CHIP } from '../stages/domain/types.js';
import {
  STATE_COPY,
  policyVersionLabel,
  type State,
} from '../domain/lifecycle/vocabulary.js';

export const PURPOSE = 'problem_updates_email';

export type NotificationKind =
  | 'state_changed'
  | 'stage_changed'
  | 'plan_changed'
  | 'decision_recorded'
  | 'task_updated'
  | 'reopened';

export interface Mapped {
  kind: NotificationKind;
  /** Fixed public wording only. */
  label: string;
}

const STATE_EVENTS = new Set([
  'state_changed',
  'published',
  'solved',
  'closed',
  'redirected',
]);

/**
 * problem_event row to a notification. Ids and fixed labels only: review content, recommendations and
 * reviewer identities never map (REVIEW-1). contribution_published and re_reviewed have no producing event
 * yet; add a case here when 09-u63 and the contribution accept path write one.
 */
export function mapProblemEvent(e: {
  type: string;
  toState: string | null;
  payload: Record<string, unknown> | null;
}): Mapped | null {
  const t = e.payload?.transitionId;
  const pv = e.payload?.policyVersion;
  if (e.type === 'plan_changed')
    return { kind: 'plan_changed', label: 'Plan changed' };
  if (t === 'T20' || t === 'T21')
    return {
      kind: 'reopened',
      label:
        typeof pv === 'string'
          ? `Reopened under policy ${policyVersionLabel(pv)}`
          : 'Reopened',
    };
  const to = e.toState as State | null;
  if (STATE_EVENTS.has(e.type) && to && to in STATE_COPY)
    return { kind: 'state_changed', label: STATE_COPY[to].label };
  return null;
}

export function mapStageEvent(e: {
  type: string;
  toState: string | null;
}): Mapped | null {
  if (e.type === 'choice_recorded')
    return { kind: 'decision_recorded', label: 'A decision was recorded' };
  if (e.type === 'task_claimed')
    return { kind: 'task_updated', label: 'A task was claimed' };
  if (e.type === 'task_done')
    return { kind: 'task_updated', label: 'A task was completed' };
  if (
    e.type === 'state_changed' &&
    (e.toState === 'ready' || e.toState === 'resolved')
  )
    return {
      kind: 'stage_changed',
      label: `A stage became ${STAGE_CHIP[e.toState]}`,
    };
  return null;
}

export const EXPLANATION: Record<NotificationKind, string> = {
  state_changed: 'The problem moved to a new state.',
  stage_changed: 'A stage of its plan changed.',
  plan_changed: 'The plan was changed. The page shows what changed and why.',
  decision_recorded: 'A choice was recorded. The page shows how it was made.',
  task_updated: 'A step of a stage was taken up or finished.',
  reopened: 'It was reopened after a rule change. The page explains why.',
};
