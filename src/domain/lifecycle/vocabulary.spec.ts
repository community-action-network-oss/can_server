import { describe, expect, it } from 'vitest';
import {
  STATES,
  STATE_CLASS,
  STATE_COPY,
  activeLabel,
  decidedUnderLabel,
  isPublicState,
  reopenedLabel,
  transitionalLabel,
  type State,
} from './vocabulary.js';

const allStrings = () => [
  ...STATES.flatMap((s) => Object.values(STATE_COPY[s])),
  activeLabel({ kind: 'one', name: 'Facts' }),
  activeLabel({ kind: 'many', n: 3 }),
  activeLabel(null),
  decidedUnderLabel('solved', 'x@1.2.0+0123456789ab')!,
  reopenedLabel('v2'),
  transitionalLabel('v2'),
];

describe('lifecycle vocabulary', () => {
  it('covers every state with copy and a class', () => {
    expect(STATES).toHaveLength(12);
    for (const s of STATES) {
      expect(STATE_CLASS[s]).toBeDefined();
      for (const v of Object.values(STATE_COPY[s])) expect(v.length).toBeGreaterThan(0);
    }
  });

  it('matches the spec labels verbatim', () => {
    const expected: Record<string, string> = {
      draft: 'Draft',
      in_review: 'In volunteer review',
      needs_revision: 'Changes requested',
      held: 'Waiting for the check',
      rejected: 'Not accepted',
      paused: 'Paused',
      stuck: 'Stuck',
      solved: 'Solved',
      closed: 'Closed',
      redirected: 'Redirected',
      withdrawn: 'Withdrawn',
    };
    for (const [s, l] of Object.entries(expected)) expect(STATE_COPY[s as State].label).toBe(l);
  });

  it('has no dashes, interim or moderator; volunteer only in in_review', () => {
    for (const t of allStrings()) {
      expect(t).not.toMatch(/[—–]/);
      expect(t).not.toMatch(/interim|moderator/i);
    }
    for (const s of STATES) {
      const has = Object.values(STATE_COPY[s]).some((v) => /volunteer/i.test(v));
      expect(has).toBe(s === 'in_review' || s === 'draft');
    }
  });

  it('isPublicState', () => {
    for (const s of ['draft', 'in_review', 'needs_revision', 'held', 'rejected'] as const)
      expect(isPublicState(s, true)).toBe(false);
    for (const s of ['active', 'paused', 'stuck', 'solved', 'closed', 'redirected'] as const)
      expect(isPublicState(s)).toBe(true);
    expect(isPublicState('withdrawn', false)).toBe(false);
    expect(isPublicState('withdrawn', true)).toBe(true);
  });

  it('activeLabel', () => {
    expect(activeLabel({ kind: 'one', name: 'Facts' })).toBe('Active: stage Facts');
    expect(activeLabel({ kind: 'many', n: 3 })).toBe('Active: 3 stages in progress');
    expect(activeLabel({ kind: 'many', n: 1 })).toBe('Active: 1 stage in progress');
    expect(activeLabel(null)).toBe('Active');
  });

  it('policy labels accept name@semver+hash and plain versions', () => {
    expect(decidedUnderLabel('solved', 'civic@1.2.0+0123456789ab')).toBe('Decided under policy v1.2.0');
    expect(decidedUnderLabel('closed', 'v3')).toBe('Decided under policy v3');
    expect(decidedUnderLabel('active', 'v3')).toBeNull();
    expect(reopenedLabel('2')).toBe('Reopened under policy v2');
    expect(transitionalLabel('v2')).toBe('Policy v2, transitional stewardship');
  });
});
