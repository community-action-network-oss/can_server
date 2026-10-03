import { describe, expect, it } from 'vitest';
import { mapProblemEvent, mapStageEvent } from './notification-kinds.js';

describe('notification mapping', () => {
  it('maps public lifecycle events to fixed labels', () => {
    const p = (type: string, toState: string | null, payload = {}) =>
      mapProblemEvent({ type, toState, payload });
    expect(p('published', 'active')).toEqual({
      kind: 'state_changed',
      label: 'Active',
    });
    expect(p('plan_changed', 'active')?.label).toBe('Plan changed');
    expect(
      p('state_changed', 'active', {
        transitionId: 'T20',
        policyVersion: 'x@1.2.0+0123456789ab',
      }),
    ).toEqual({ kind: 'reopened', label: 'Reopened under policy v1.2.0' });
    expect(p('contribution.submitted', null)).toBeNull();
    expect(p('transition_proposed', null, { transitionId: 'T04' })).toBeNull();
  });
  it('maps task claimed and done to task_updated, other task events to nothing', () => {
    expect(mapStageEvent({ type: 'task_claimed', toState: null })).toEqual({
      kind: 'task_updated',
      label: 'A task was claimed',
    });
    expect(mapStageEvent({ type: 'task_done', toState: null })?.label).toBe(
      'A task was completed',
    );
    expect(mapStageEvent({ type: 'task_progress', toState: null })).toBeNull();
  });
  it('maps only ready and done stage changes and recorded choices', () => {
    expect(
      mapStageEvent({ type: 'state_changed', toState: 'ready' })?.label,
    ).toBe('A stage became Ready');
    expect(
      mapStageEvent({ type: 'state_changed', toState: 'resolved' })?.label,
    ).toBe('A stage became Done');
    expect(
      mapStageEvent({ type: 'state_changed', toState: 'blocked' }),
    ).toBeNull();
    expect(
      mapStageEvent({ type: 'choice_recorded', toState: null })?.kind,
    ).toBe('decision_recorded');
    expect(mapStageEvent({ type: 'evidence_added', toState: null })).toBeNull();
  });
});
