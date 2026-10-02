import { describe, expect, it } from 'vitest';
import { evaluateQuorum, readReviewLimits } from './quorum.js';

const DAY = 86_400_000;
const t0 = new Date('2026-10-01T00:00:00Z');
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const q = (finished: number, day: number, openAgeDays: number | null = null) =>
  evaluateQuorum({
    finishedReviews: finished,
    reviewRequestedAt: t0,
    now: at(day),
    oldestOpenAt: openAgeDays === null ? null : at(day - openAgeDays),
  });

describe('evaluateQuorum', () => {
  it('zero reviews never publishes and asks for reviewers', () => {
    for (const day of [0, 14, 400]) {
      const r = q(0, day);
      expect(r).toMatchObject({
        quorumMet: false,
        canRequestPublication: false,
        needsReviewers: true,
      });
    }
  });
  it.each([
    [1, 3, false, false],
    [2, 3, false, false],
    [3, 3, true, true],
    [1, 13, false, false],
    [1, 14, false, true],
    [2, 14, false, true],
  ])('%i reviews on day %i', (n, day, quorum, can) => {
    const r = q(n, day);
    expect(r.quorumMet).toBe(quorum);
    expect(r.canRequestPublication).toBe(can);
    expect(r.needsReviewers).toBe(false);
  });
  it('a recommendation open more than 7 days blocks the quorum, exactly 7 does not', () => {
    expect(q(3, 8, 8).quorumMet).toBe(false);
    expect(q(3, 8, 7).quorumMet).toBe(true);
    expect(q(3, 8, 8).canRequestPublication).toBe(false);
    expect(q(3, 14, 14).canRequestPublication).toBe(true);
  });
});

describe('readReviewLimits', () => {
  it('falls back to D-74 defaults when the pack has no review block', () => {
    expect(readReviewLimits({})).toEqual({
      quorumCompletedReviews: 3,
      recommendationOpenMaxDays: 7,
      publishAnywayAfterDays: 14,
    });
    expect(readReviewLimits(undefined).quorumCompletedReviews).toBe(3);
  });
  it('reads values and ignores bad ones', () => {
    const l = readReviewLimits({
      review: {
        quorum_completed_reviews: { value: 5 },
        recommendation_open_max_days: { value: -1 },
        publish_anyway_after_days: 20,
      },
    });
    expect(l).toEqual({
      quorumCompletedReviews: 5,
      recommendationOpenMaxDays: 7,
      publishAnywayAfterDays: 20,
    });
  });
});
