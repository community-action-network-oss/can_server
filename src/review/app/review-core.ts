import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  and,
  count,
  countDistinct,
  eq,
  inArray,
  isNotNull,
  min,
} from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import {
  problem,
  problemEvent,
  problemVersion,
  reviewRecommendation,
  reviewSession,
} from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';
import { CLOCK, type Clock } from '../../platform/ports.js';
import { PolicyStore } from '../../policy/app/policy-store.js';
import type {
  ReviewFacts,
  ReviewHooks,
} from '../../problems/app/transition-ports.js';
import {
  evaluateQuorum,
  readReviewLimits,
  type QuorumResult,
} from '../domain/quorum.js';

export interface ReviewStatus extends QuorumResult {
  openRecommendations: number;
  publicationRequested: boolean;
}

/** Real review facts for T04, and the numbers behind review-status. Reads only this module's tables. */
@Injectable()
export class ReviewFactsImpl implements ReviewFacts {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly policy?: PolicyStore,
  ) {}

  async status(tx: Tx | Db, problemId: string): Promise<ReviewStatus> {
    const [p] = await tx
      .select({
        at: problem.reviewRequestedAt,
        j: problem.jurisdictionId,
      })
      .from(problem)
      .where(eq(problem.id, problemId));
    const [fin] = await tx
      .select({ n: countDistinct(reviewSession.reviewerId) })
      .from(reviewSession)
      .where(
        and(
          eq(reviewSession.problemId, problemId),
          isNotNull(reviewSession.finishedAt),
        ),
      );
    const [open] = await tx
      .select({ n: count(), oldest: min(reviewRecommendation.openedAt) })
      .from(reviewRecommendation)
      .where(
        and(
          eq(reviewRecommendation.problemId, problemId),
          eq(reviewRecommendation.status, 'open'),
        ),
      );
    const requested = await tx
      .select({ id: problemEvent.id })
      .from(problemEvent)
      .where(
        and(
          eq(problemEvent.problemId, problemId),
          eq(problemEvent.type, 'publication_requested'),
        ),
      )
      .limit(1);
    const q = evaluateQuorum({
      finishedReviews: fin?.n ?? 0,
      oldestOpenAt: open?.oldest ?? null,
      reviewRequestedAt: p?.at ?? null,
      now: this.clock.now(),
      limits: this.limits(p?.j ?? null),
    });
    return {
      ...q,
      openRecommendations: open?.n ?? 0,
      publicationRequested: requested.length > 0,
    };
  }

  /** No active pack, or a pack without the review block, means the D-74 defaults. */
  private limits(jurisdictionId: string | null) {
    try {
      return readReviewLimits(
        this.policy?.active(jurisdictionId ?? 'default').limits,
      );
    } catch {
      return readReviewLimits(undefined);
    }
  }

  async get(tx: Tx, problemId: string) {
    const s = await this.status(tx, problemId);
    return {
      atLeastOneCompletedReview: s.atLeastOneCompletedReview,
      // Quorum, or the poster's explicit send-anyway after the waiting period (12-u03 step 6).
      reviewQuorumMetOrPosterOverride:
        s.quorumMet || (s.canRequestPublication && s.publicationRequested),
    };
  }
}

/** What the review module does when preparation moves (12-u04 hooks). Every call runs in the caller's transaction. */
@Injectable()
export class ReviewHooksImpl implements ReviewHooks {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /** Copy of the problem text at this version. Raw user content: masked on read, deleted by endAccess. */
  private async snapshot(tx: Tx, problemId: string, version: number) {
    const [r] = await tx
      .select()
      .from(problem)
      .where(eq(problem.id, problemId));
    if (!r) return;
    const snapshot = {
      title: r.title,
      condition: r.condition,
      affected: r.affected,
      coarseArea: r.coarseArea,
      desiredOutcome: r.desiredOutcome,
      observed: r.observed,
      uncertain: r.uncertain,
      content: r.content,
    };
    await tx
      .insert(problemVersion)
      .values({ problemId, version, snapshot, createdAt: this.clock.now() })
      .onConflictDoUpdate({
        target: [problemVersion.problemId, problemVersion.version],
        set: { snapshot },
      });
  }

  async enterQueue(tx: Tx, problemId: string) {
    const [r] = await tx
      .select({ v: problem.version })
      .from(problem)
      .where(eq(problem.id, problemId));
    if (r) await this.snapshot(tx, problemId, r.v);
  }

  async markChanged(
    tx: Tx,
    problemId: string,
    version: number,
    paths: string[],
  ) {
    await this.snapshot(tx, problemId, version);
    if (!paths.length) return;
    await tx
      .update(reviewRecommendation)
      .set({ changedAtVersion: version })
      .where(
        and(
          eq(reviewRecommendation.problemId, problemId),
          inArray(reviewRecommendation.path, paths),
        ),
      );
  }

  /** T03: a resolved recommendation whose path changed is open again, with a fresh open-age clock. */
  async reopen(tx: Tx, problemId: string, paths: string[]) {
    if (!paths.length) return;
    const now = this.clock.now();
    await tx
      .update(reviewRecommendation)
      .set({
        status: 'open',
        resolutionReason: null,
        resolvedAt: null,
        openedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(reviewRecommendation.problemId, problemId),
          inArray(reviewRecommendation.status, ['accepted', 'declined']),
          inArray(reviewRecommendation.path, paths),
        ),
      );
  }

  /** T05, T06, T07: volunteers lose access and the text copies go. Recommendations stay as history. */
  async endAccess(tx: Tx, problemId: string) {
    await tx
      .update(reviewSession)
      .set({ accessEndedAt: this.clock.now() })
      .where(eq(reviewSession.problemId, problemId));
    await tx
      .delete(problemVersion)
      .where(eq(problemVersion.problemId, problemId));
  }
}
