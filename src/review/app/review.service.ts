import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import {
  account,
  problem,
  reviewRecommendation,
  reviewSession,
} from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { ApiException } from '../../platform/errors.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import { StructuredContentService } from '../../policy/app/structured-content.service.js';
import {
  ContentSchemaNotFound,
  PolicyUnavailable,
} from '../../policy/domain/pack.js';
import { applyMasked, collectStrings } from '../domain/mask-view.js';
import { QUEUE_PAGE, RECOMMENDATIONS_PER_DAY } from '../domain/quorum.js';
import { maskOrFail, PROBLEM_MASKER, type ProblemMasker } from './masker.js';

const DAY = 86_400_000;
const TEXT_COLUMNS = [
  'title',
  'condition',
  'affected',
  'coarseArea',
  'desiredOutcome',
  'observed',
  'uncertain',
] as const;
export const REVIEW_TYPE = 'review_recommendation';

const notFound = () => new ApiException(404, 'not_found', 'Problem not found');
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

/** Schema calls unavailable closed: no pack means no recommendation. */
export const policyDown = (e: unknown) =>
  e instanceof PolicyUnavailable || e instanceof ContentSchemaNotFound
    ? new ApiException(503, 'policy_unavailable', 'Policy is not available.')
    : e;

/** Volunteer side of review (REVIEW-1): opt-in, queue, masked view, recommendations. Nothing here is public. */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(StructuredContentService)
    private readonly structured: StructuredContentService,
    @Inject(PROBLEM_MASKER) private readonly masker: ProblemMasker,
  ) {}

  // Opt-in -----------------------------------------------------------------

  async optIn(accountId: string, on: boolean) {
    const now = this.clock.now();
    const [a] = await this.db
      .update(account)
      .set(
        on
          ? { volunteerReviewer: true, volunteerReviewerSince: now }
          : { volunteerReviewer: false },
      )
      .where(eq(account.id, accountId))
      .returning({
        on: account.volunteerReviewer,
        since: account.volunteerReviewerSince,
      });
    return { optedIn: a?.on ?? false, since: a?.since?.toISOString() ?? null };
  }

  async optInState(accountId: string) {
    const [a] = await this.db
      .select({
        on: account.volunteerReviewer,
        since: account.volunteerReviewerSince,
      })
      .from(account)
      .where(eq(account.id, accountId));
    return {
      optedIn: a?.on ?? false,
      since: (a?.on && a.since?.toISOString()) || null,
    };
  }

  private async requireVolunteer(db: Tx | Db, accountId: string) {
    const [a] = await db
      .select({ on: account.volunteerReviewer, gone: account.deletedAt })
      .from(account)
      .where(eq(account.id, accountId));
    if (!a?.on || a.gone)
      throw new ApiException(
        403,
        'not_permitted',
        'Volunteer review is opt-in. Turn it on first.',
      );
  }

  /** An in_review problem the volunteer may look at: not their own (403), not anything else (404). */
  private async reviewable(db: Tx | Db, accountId: string, id: string) {
    await this.requireVolunteer(db, accountId);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const [r] = await db.select().from(problem).where(eq(problem.id, id));
    if (!r || r.deletedAt || r.state !== 'in_review') throw notFound();
    if (r.initiatorId === accountId)
      throw new ApiException(
        403,
        'not_permitted',
        'You cannot review your own problem.',
      );
    return r;
  }

  private async openSession(db: Tx | Db, accountId: string, id: string) {
    const [s] = await db
      .select()
      .from(reviewSession)
      .where(
        and(
          eq(reviewSession.problemId, id),
          eq(reviewSession.reviewerId, accountId),
        ),
      );
    if (!s || s.accessEndedAt)
      throw new ApiException(
        403,
        'not_permitted',
        'Declare that you have no conflict first.',
      );
    return s;
  }

  // Queue and session ------------------------------------------------------

  async queue(accountId: string) {
    await this.requireVolunteer(this.db, accountId);
    const rows = await this.db
      .select()
      .from(problem)
      .where(
        and(
          eq(problem.state, 'in_review'),
          isNotNull(problem.reviewRequestedAt),
          sql`${problem.deletedAt} is null`,
          sql`${problem.initiatorId} is distinct from ${accountId}`,
        ),
      )
      .orderBy(sql`random()`)
      .limit(QUEUE_PAGE);
    const mine = new Map(
      (
        await this.db
          .select()
          .from(reviewSession)
          .where(eq(reviewSession.reviewerId, accountId))
      ).map((s) => [s.problemId, s]),
    );
    const m = maskOrFail(
      this.masker,
      rows.flatMap((r) =>
        (['title', 'coarseArea'] as const).flatMap((k) =>
          r[k] ? [{ fieldRef: `/${r.id}/${k}`, text: r[k] }] : [],
        ),
      ),
    );
    const text = new Map(m.fields.map((f) => [f.fieldRef, f.text]));
    return {
      items: rows.map((r) => {
        const s = mine.get(r.id);
        return {
          problemId: r.id,
          title: text.get(`/${r.id}/title`) ?? null,
          coarseArea: text.get(`/${r.id}/coarseArea`) ?? null,
          stageCount: arr(r.content?.stage_plan).length,
          sourceCount: arr(r.content?.sources).length,
          mine: !s ? 'new' : s.finishedAt ? 'finished' : 'in_progress',
        };
      }),
    };
  }

  async declare(accountId: string, id: string, noConflict: boolean) {
    if (noConflict !== true)
      throw new ApiException(
        400,
        'validation_failed',
        'Confirm that you have no conflict of interest.',
        { noConflict: 'required' },
      );
    return withTransaction(this.db, async (tx) => {
      await this.reviewable(tx, accountId, id);
      const now = this.clock.now();
      await tx
        .insert(reviewSession)
        .values({
          id: this.ids.next(),
          problemId: id,
          reviewerId: accountId,
          conflictDeclaredAt: now,
          createdAt: now,
        })
        .onConflictDoNothing();
      const [s] = await tx
        .select()
        .from(reviewSession)
        .where(
          and(
            eq(reviewSession.problemId, id),
            eq(reviewSession.reviewerId, accountId),
          ),
        );
      return {
        problemId: id,
        conflictDeclaredAt: s!.conflictDeclaredAt.toISOString(),
        finished: s!.finishedAt !== null,
      };
    });
  }

  // Masked view ------------------------------------------------------------

  /** Structured problem, sources, final criteria and stage plan with personal data masked. Never raw text (REVIEW-1). */
  async view(accountId: string, id: string) {
    const r = await this.reviewable(this.db, accountId, id);
    await this.openSession(this.db, accountId, id);
    const fields = TEXT_COLUMNS.flatMap((k) =>
      r[k] ? [{ fieldRef: `/fields/${k}`, text: r[k]! }] : [],
    );
    const m = maskOrFail(this.masker, [
      ...fields,
      ...collectStrings(r.content ?? {}, '/content'),
    ]);
    const text = new Map(m.fields.map((f) => [f.fieldRef, f.text]));
    return {
      problemId: r.id,
      version: r.version,
      fields: Object.fromEntries(
        TEXT_COLUMNS.map((k) => [
          k,
          r[k] ? (text.get(`/fields/${k}`) ?? '') : null,
        ]),
      ),
      content: applyMasked(r.content ?? {}, '/content', text),
      redactionCount: m.redactionCount,
    };
  }

  // Recommendations --------------------------------------------------------

  async recommend(
    accountId: string,
    id: string,
    input: { path: string; recommendation: string; reason: string },
  ) {
    return withTransaction(this.db, async (tx) => {
      const r = await this.reviewable(tx, accountId, id);
      const s = await this.openSession(tx, accountId, id);
      if (s.finishedAt)
        throw new ApiException(
          409,
          'invalid_transition',
          'Your review is finished.',
        );
      const now = this.clock.now();
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(reviewRecommendation)
        .where(
          and(
            eq(reviewRecommendation.reviewerId, accountId),
            gte(reviewRecommendation.createdAt, new Date(now.getTime() - DAY)),
          ),
        );
      if (n >= RECOMMENDATIONS_PER_DAY)
        throw new ApiException(
          429,
          'rate_limited',
          'You have reached the daily limit for recommendations.',
        );
      // Personal data goes before anything is stored; the original text is discarded here.
      const masked = maskOrFail(this.masker, [
        { fieldRef: 'recommendation', text: input.recommendation },
        { fieldRef: 'reason', text: input.reason },
      ]);
      const [rec, why] = masked.fields.map((f) => f.text);
      this.assertPathExists(input.path, r.content);
      try {
        const stamp = await this.structured.stamp(tx, REVIEW_TYPE, now);
        await this.structured.validate(tx, REVIEW_TYPE, stamp, {
          problem_ref: id,
          path: input.path,
          recommendation: rec,
          reason: why,
          status: 'open',
        });
      } catch (e) {
        throw policyDown(e);
      }
      const recId = this.ids.next();
      await tx.insert(reviewRecommendation).values({
        id: recId,
        problemId: id,
        reviewerId: accountId,
        path: input.path,
        recommendation: rec,
        reason: why,
        openedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { id: recId, status: 'open' as const };
    });
  }

  /** The schema pins the path shape; a stage path must also name a stage that is in this plan. */
  private assertPathExists(
    path: string,
    content: Record<string, unknown> | null,
  ) {
    const m = /^stage_plan\.([^.]+)(\.criteria)?$/.exec(path);
    if (!m) return;
    if (!arr(content?.stage_plan).some((n) => n.name === m[1]))
      throw new ApiException(
        400,
        'validation_failed',
        'That part is not in this problem.',
        { path: 'No stage with that name.' },
      );
  }

  async finish(
    accountId: string,
    id: string,
    outcome: 'recommendations' | 'no_changes',
  ) {
    return withTransaction(this.db, async (tx) => {
      await this.reviewable(tx, accountId, id);
      const s = await this.openSession(tx, accountId, id);
      if (s.finishedAt)
        throw new ApiException(
          409,
          'invalid_transition',
          'Your review is already finished.',
        );
      const mine = await tx
        .select({ id: reviewRecommendation.id })
        .from(reviewRecommendation)
        .where(
          and(
            eq(reviewRecommendation.problemId, id),
            eq(reviewRecommendation.reviewerId, accountId),
          ),
        );
      if ((outcome === 'no_changes') !== (mine.length === 0))
        throw new ApiException(
          400,
          'validation_failed',
          outcome === 'no_changes'
            ? 'You added recommendations, so finish with them.'
            : 'Add a recommendation, or finish with no changes.',
          { outcome: 'does not match your recommendations' },
        );
      const now = this.clock.now();
      await tx
        .update(reviewSession)
        .set({ finishedAt: now, outcome })
        .where(eq(reviewSession.id, s.id));
      return { outcome, finishedAt: now.toISOString() };
    });
  }

  /** Your own recommendations with the poster's answers. Aggregate counts appear only after you finish. */
  async mine(accountId: string, id: string) {
    const r = await this.reviewable(this.db, accountId, id);
    const s = await this.openSession(this.db, accountId, id);
    const rows = await this.db
      .select()
      .from(reviewRecommendation)
      .where(
        and(
          eq(reviewRecommendation.problemId, id),
          eq(reviewRecommendation.reviewerId, accountId),
        ),
      )
      .orderBy(asc(reviewRecommendation.createdAt));
    let aggregate: {
      finishedReviews: number;
      open: number;
      accepted: number;
      declined: number;
    } | null = null;
    if (s.finishedAt) {
      const all = await this.db
        .select({ status: reviewRecommendation.status })
        .from(reviewRecommendation)
        .where(eq(reviewRecommendation.problemId, id));
      const fin = await this.db
        .select({ id: reviewSession.id })
        .from(reviewSession)
        .where(
          and(
            eq(reviewSession.problemId, id),
            isNotNull(reviewSession.finishedAt),
          ),
        );
      const c = (st: string) => all.filter((x) => x.status === st).length;
      aggregate = {
        finishedReviews: fin.length,
        open: c('open'),
        accepted: c('accepted'),
        declined: c('declined'),
      };
    }
    return {
      version: r.version,
      finished: s.finishedAt !== null,
      recommendations: rows.map((x) => ({
        id: x.id,
        path: x.path,
        recommendation: x.recommendation,
        reason: x.reason,
        status: x.status,
        resolutionReason: x.resolutionReason,
        changedSince: x.changedAtVersion !== null,
        createdAt: x.createdAt.toISOString(),
      })),
      aggregate,
    };
  }
}
