import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import {
  problem,
  problemEvent,
  reviewRecommendation,
  reviewSession,
} from '../../db/schema.js';
import { withTransaction } from '../../db/tx.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import { ApiException } from '../../platform/errors.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import { StructuredContentService } from '../../policy/app/structured-content.service.js';
import { DraftsService } from '../../problems/app/drafts.service.js';
import { maskOrFail, PROBLEM_MASKER, type ProblemMasker } from './masker.js';
import { ReviewFactsImpl } from './review-core.js';
import { policyDown, REVIEW_TYPE } from './review.service.js';

const UUID = /^[0-9a-f-]{36}$/i;
const notFound = () => new ApiException(404, 'not_found', 'Not found');

export interface ResolveInput {
  decision: 'accept' | 'decline';
  reason: string;
  /** Optional: the new value at a top-level path, applied to the draft with the accept. */
  value?: unknown;
  expectedVersion?: number;
}

/** Poster side of review: read recommendations (reviewers anonymous), answer each one (RECO-1), ask for publication. */
@Injectable()
export class PosterReviewService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(StructuredContentService)
    private readonly structured: StructuredContentService,
    @Inject(PROBLEM_MASKER) private readonly masker: ProblemMasker,
    @Inject(DraftsService) private readonly drafts: DraftsService,
    private readonly facts: ReviewFactsImpl,
  ) {}

  private async own(accountId: string, id: string) {
    if (!UUID.test(id)) throw notFound();
    const [r] = await this.db.select().from(problem).where(eq(problem.id, id));
    if (!r || r.initiatorId !== accountId || r.deletedAt) throw notFound();
    return r;
  }

  async list(accountId: string, id: string) {
    await this.own(accountId, id);
    const sessions = await this.db
      .select()
      .from(reviewSession)
      .where(eq(reviewSession.problemId, id))
      .orderBy(asc(reviewSession.createdAt));
    const label = new Map(
      sessions.map((s, i) => [s.reviewerId, `Volunteer ${i + 1}`]),
    );
    const rows = await this.db
      .select()
      .from(reviewRecommendation)
      .where(eq(reviewRecommendation.problemId, id))
      .orderBy(asc(reviewRecommendation.createdAt));
    return {
      items: rows.map((x) => ({
        id: x.id,
        volunteer: label.get(x.reviewerId) ?? 'Volunteer',
        path: x.path,
        recommendation: x.recommendation,
        reason: x.reason,
        status: x.status,
        resolutionReason: x.resolutionReason,
        changedSince: x.changedAtVersion !== null,
        openedAt: x.openedAt.toISOString(),
      })),
    };
  }

  async resolve(accountId: string, recId: string, i: ResolveInput) {
    if (!UUID.test(recId)) throw notFound();
    const [rec] = await this.db
      .select()
      .from(reviewRecommendation)
      .where(eq(reviewRecommendation.id, recId));
    if (!rec) throw notFound();
    const p = await this.own(accountId, rec.problemId);
    if (p.state !== 'in_review')
      throw new ApiException(
        409,
        'invalid_transition',
        'Recommendations are answered while the problem is in review.',
      );
    if (rec.status !== 'open')
      throw new ApiException(
        409,
        'invalid_transition',
        'This recommendation is already answered.',
      );
    const status = i.decision === 'accept' ? 'accepted' : 'declined';
    const reason = maskOrFail(this.masker, [
      { fieldRef: 'reason', text: i.reason },
    ]).fields[0].text;
    try {
      const stamp = await this.structured.stamp(
        this.db,
        REVIEW_TYPE,
        this.clock.now(),
      );
      await this.structured.validate(this.db, REVIEW_TYPE, stamp, {
        problem_ref: p.id,
        path: rec.path,
        recommendation: rec.recommendation,
        reason: rec.reason,
        status,
        resolution_reason: reason,
      });
    } catch (e) {
      throw policyDown(e);
    }
    const apply = status === 'accepted' && i.value !== undefined;
    if (apply) {
      if (rec.path.includes('.') || i.expectedVersion === undefined)
        throw new ApiException(
          400,
          'validation_failed',
          'Edit stage plan parts in the plan editor, and send the version you saw.',
          { value: 'Only a top-level part with expectedVersion.' },
        );
      // The poster can still edit afterwards; the draft path validates against the pinned schema.
      await this.drafts.update(accountId, p.id, {}, i.expectedVersion, {
        content: { ...p.content, [rec.path]: i.value },
      });
    }
    const now = this.clock.now();
    await withTransaction(this.db, (tx) =>
      tx
        .update(reviewRecommendation)
        .set({
          status,
          resolutionReason: reason,
          resolvedAt: now,
          updatedAt: now,
          ...(apply && { changedAtVersion: null }),
        })
        .where(eq(reviewRecommendation.id, recId)),
    );
    return { id: recId, status, resolutionReason: reason };
  }

  async status(accountId: string, id: string) {
    await this.own(accountId, id);
    const s = await this.facts.status(this.db, id);
    return {
      reviewCount: s.reviewCount,
      dayCount: s.dayCount,
      openRecommendations: s.openRecommendations,
      quorumMet: s.quorumMet,
      canRequestPublication: s.canRequestPublication,
      needsReviewers: s.needsReviewers,
    };
  }

  /** Records the request (ids only). The publication decision itself is picked up by 12-u08. */
  async requestPublication(accountId: string, id: string) {
    const now = this.clock.now();
    return withTransaction(this.db, async (tx) => {
      const [p] = await tx
        .select()
        .from(problem)
        .where(
          eq(
            problem.id,
            UUID.test(id) ? id : '00000000-0000-0000-0000-000000000000',
          ),
        )
        .for('update');
      if (!p || p.initiatorId !== accountId || p.deletedAt) throw notFound();
      if (p.state !== 'in_review')
        throw new ApiException(
          409,
          'invalid_transition',
          'Only a problem in review can be sent for publication.',
        );
      const s = await this.facts.status(tx, id);
      if (!s.canRequestPublication)
        throw new ApiException(
          403,
          'not_permitted',
          s.needsReviewers
            ? 'It needs at least one completed review first.'
            : 'It needs more reviews, or more days, first.',
        );
      if (!s.publicationRequested)
        await tx.insert(problemEvent).values({
          id: this.ids.next(),
          problemId: id,
          type: 'publication_requested',
          actorId: accountId,
          fromState: 'in_review',
          toState: null,
          payload: {},
          originNodeId: config.nodeId,
          protocolVersion: PROTOCOL_VERSION,
          occurredAt: now,
        });
      return { requested: true as const };
    });
  }
}
