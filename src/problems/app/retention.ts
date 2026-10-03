import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import {
  acceptanceCriterion,
  problem,
  problemVersion,
  reviewRecommendation,
  sourceRef,
  stage,
  stageEdge,
  stageEvent,
} from '../../db/schema.js';
import { withTransaction } from '../../db/tx.js';
import { MailDecisionNotifier } from '../../moderation/infra/notifier.js';
import { log } from '../../platform/logging/logger.js';
import { revisionReminder } from '../../platform/mail/templates.js';
import { config } from '../../config.js';
import { TransitionEngine } from './transition-engine.js';

const DAY = 86_400_000;
export const REMIND_AFTER_DAYS = 23;
export const WITHDRAW_AFTER_DAYS = 30;

/**
 * Retention for problem content (DRAFT-TTL-1). Each method takes `now` so tests drive the clock and
 * every method is safe to run twice. Never UPDATE or DELETE an insert-only table here.
 */
@Injectable()
export class ProblemRetention {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TransitionEngine) private readonly engine: TransitionEngine,
    @Inject(MailDecisionNotifier)
    private readonly mail: MailDecisionNotifier,
  ) {}

  /**
   * Rejected or withdrawn pre-publication problems past purge_after lose all user content. The stub row
   * stays so insert-only events and decisions remain referable (moderation_decision hints and spans are
   * insert-only and hold rule-based hints, not user text, so they are kept).
   * Caches: nothing to purge in slice 1.
   */
  async purgeDrafts(now: Date): Promise<number> {
    const due = await this.db
      .select({ id: problem.id })
      .from(problem)
      .where(
        and(
          inArray(problem.state, ['rejected', 'withdrawn']),
          isNull(problem.publishedAt),
          isNull(problem.purgedAt),
          lte(problem.purgeAfter, now),
        ),
      );
    for (const { id } of due) await this.purgeOne(id, now);
    return due.length;
  }

  private purgeOne(id: string, now: Date) {
    return withTransaction(this.db, async (tx) => {
      const [r] = await tx
        .select({ version: problem.version, purgedAt: problem.purgedAt })
        .from(problem)
        .where(eq(problem.id, id))
        .for('update');
      if (!r || r.purgedAt) return;
      await tx.delete(sourceRef).where(eq(sourceRef.problemId, id));
      await tx
        .delete(acceptanceCriterion)
        .where(eq(acceptanceCriterion.problemId, id));
      await tx.delete(problemVersion).where(eq(problemVersion.problemId, id));
      // review_recommendation has DELETE revoked: blank the volunteer text, keep status and counts.
      await tx
        .update(reviewRecommendation)
        .set({
          recommendation: '',
          reason: '',
          resolutionReason: sql`case when ${reviewRecommendation.resolutionReason} is null then null else '' end`,
        })
        .where(eq(reviewRecommendation.problemId, id));
      // Stage rows of a pre-publication plan; a stage that has events stays (insert-only FK).
      const withEvents = tx
        .select({ id: stageEvent.stageId })
        .from(stageEvent)
        .where(eq(stageEvent.problemId, id));
      const old = (
        await tx
          .select({ id: stage.id })
          .from(stage)
          .where(and(eq(stage.problemId, id), notInArray(stage.id, withEvents)))
      ).map((x) => x.id);
      if (old.length) {
        await tx
          .delete(acceptanceCriterion)
          .where(inArray(acceptanceCriterion.stageId, old));
        await tx.delete(stageEdge).where(inArray(stageEdge.stageId, old));
        await tx.delete(stageEdge).where(inArray(stageEdge.dependsOnId, old));
        await tx.delete(stage).where(inArray(stage.id, old));
      }
      await tx
        .update(problem)
        .set({
          title: null,
          condition: null,
          affected: null,
          coarseArea: null,
          desiredOutcome: null,
          observed: null,
          uncertain: null,
          content: null,
          submitSnapshot: null,
          keptFlags: null,
          intakeEvidence: null,
          noEvidenceNote: null,
          noSourceNote: null,
          pendingTransition: null,
          helpNeeded: {
            skill_groups: [],
            languages: [],
            coarse_place: null,
            topics: [],
          },
          purgedAt: now,
          version: r.version + 1,
          updatedAt: now,
        })
        .where(eq(problem.id, id));
    });
  }

  /**
   * needs_revision idle 23 days: one reminder (stamp first, so a crash never double sends).
   * Idle 30 days: T07 by actor system. A later edit bumps updated_at past the stamp and re-arms it.
   */
  async idleRevisions(
    now: Date,
  ): Promise<{ reminded: number; withdrawn: number }> {
    const ago = (d: number) => new Date(now.getTime() - d * DAY);
    let withdrawn = 0;
    const stale = await this.db
      .select({ id: problem.id })
      .from(problem)
      .where(
        and(
          eq(problem.state, 'needs_revision'),
          lte(problem.updatedAt, ago(WITHDRAW_AFTER_DAYS)),
        ),
      );
    for (const { id } of stale) {
      try {
        await this.engine.apply({
          problemId: id,
          to: 'withdrawn',
          actor: { kind: 'system', id: null },
          transitionId: 'T07',
        });
        withdrawn++;
      } catch (e) {
        log('error', 'idle_withdraw_failed', {
          problemId: id,
          reason: e instanceof Error ? e.name : typeof e,
        });
      }
    }
    const claimed = await this.db
      .update(problem)
      .set({ reviewReminderSentAt: now })
      .where(
        and(
          eq(problem.state, 'needs_revision'),
          lte(problem.updatedAt, ago(REMIND_AFTER_DAYS)),
          or(
            isNull(problem.reviewReminderSentAt),
            lt(problem.reviewReminderSentAt, problem.updatedAt),
          ),
        ),
      )
      .returning({ id: problem.id, updatedAt: problem.updatedAt });
    for (const c of claimed) {
      // Fire and forget: sendTo never rejects and never logs the address.
      void this.mail.sendTo(
        c.id,
        'problem_revision_reminder',
        revisionReminder({
          link: `${config.appBaseUrl}/me/problems/${c.id}`,
          withdrawOn: new Date(
            c.updatedAt.getTime() + WITHDRAW_AFTER_DAYS * DAY,
          ),
        }),
      );
    }
    return { reminded: claimed.length, withdrawn };
  }
}
