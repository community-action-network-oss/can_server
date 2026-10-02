// Review quorum (REVIEW-1, OQ-review-quorum, D-74). Pure: the clock is passed in. All constants of the review unit live in this file.

const DAY = 86_400_000;

/** At least one completed review is a code constant, not a limit: nothing publishes without it. */
export const MIN_COMPLETED_REVIEWS = 1;
/** Recommendations one reviewer may add per rolling day. */
export const RECOMMENDATIONS_PER_DAY = 10;
/** Problems shown in one queue page. */
export const QUEUE_PAGE = 20;

export interface ReviewLimits {
  quorumCompletedReviews: number;
  recommendationOpenMaxDays: number;
  publishAnywayAfterDays: number;
}
export const DEFAULT_LIMITS: ReviewLimits = {
  quorumCompletedReviews: 3,
  recommendationOpenMaxDays: 7,
  publishAnywayAfterDays: 14,
};

const KEYS: Record<keyof ReviewLimits, string> = {
  quorumCompletedReviews: 'quorum_completed_reviews',
  recommendationOpenMaxDays: 'recommendation_open_max_days',
  publishAnywayAfterDays: 'publish_anyway_after_days',
};

/** `limits` is the parsed limits.yaml root; a pack that predates the `review` block (or has a bad value) falls back to the D-74 defaults. */
export function readReviewLimits(limits: unknown): ReviewLimits {
  const block = (limits as { review?: Record<string, unknown> } | null)?.review;
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(KEYS) as (keyof ReviewLimits)[]) {
    const e = block?.[KEYS[k]];
    const v =
      e && typeof e === 'object' && 'value' in e
        ? (e as { value: unknown }).value
        : e;
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v;
  }
  return out;
}

export interface QuorumInput {
  /** Distinct volunteers with a finished review. */
  finishedReviews: number;
  /** When the oldest still-open recommendation was opened, or null. */
  oldestOpenAt: Date | null;
  /** T01 time. */
  reviewRequestedAt: Date | null;
  now: Date;
  limits?: ReviewLimits;
}
export interface QuorumResult {
  reviewCount: number;
  dayCount: number;
  quorumMet: boolean;
  canRequestPublication: boolean;
  needsReviewers: boolean;
  atLeastOneCompletedReview: boolean;
}

export function evaluateQuorum(i: QuorumInput): QuorumResult {
  const l = i.limits ?? DEFAULT_LIMITS;
  const dayCount = i.reviewRequestedAt
    ? Math.max(
        0,
        Math.floor((i.now.getTime() - i.reviewRequestedAt.getTime()) / DAY),
      )
    : 0;
  const stale =
    i.oldestOpenAt !== null &&
    i.now.getTime() - i.oldestOpenAt.getTime() >
      l.recommendationOpenMaxDays * DAY;
  const one = i.finishedReviews >= MIN_COMPLETED_REVIEWS;
  const quorumMet = i.finishedReviews >= l.quorumCompletedReviews && !stale;
  return {
    reviewCount: i.finishedReviews,
    dayCount,
    quorumMet,
    // Zero finished reviews never publishes, whatever the day count.
    canRequestPublication:
      one && (quorumMet || dayCount >= l.publishAnywayAfterDays),
    needsReviewers: !one,
    atLeastOneCompletedReview: one,
  };
}
