import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { AuthService } from '../../accounts/app/auth.service.js';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import { moderationDecision, problem, problemEvent } from '../../db/schema.js';
import { log } from '../../platform/logging/logger.js';
import {
  changesRequested,
  inReview,
  notAccepted,
  published,
  waitingForCheck,
  type Rendered,
} from '../../platform/mail/templates.js';
import type { DecisionNotifier } from '../../problems/app/transition-ports.js';

/**
 * Plain decision emails to the initiator (03-u11). Best effort: runs after commit, a failure is
 * logged without the address and never touches the decision. Only AuthService sees the plaintext.
 */
@Injectable()
export class MailDecisionNotifier implements DecisionNotifier {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuthService) private readonly accounts: AuthService,
  ) {}

  /** Applied transitions that have an email. The transition id comes from the event the engine just wrote. */
  notify(n: Parameters<DecisionNotifier['notify']>[0]): Promise<void> {
    void this.deliver(n); // fire and forget (02-u07): the response never waits for the mail server
    return Promise.resolve();
  }

  /** Same as notify but resolves when the mail was handed over; never rejects. */
  async deliver(n: Parameters<DecisionNotifier['notify']>[0]): Promise<void> {
    if (n.kind !== 'applied') return;
    try {
      const [ev] = await this.db
        .select({ payload: problemEvent.payload })
        .from(problemEvent)
        .where(eq(problemEvent.problemId, n.problemId))
        .orderBy(desc(problemEvent.occurredAt), desc(problemEvent.id))
        .limit(1);
      const t = (ev?.payload as { transitionId?: string } | null)?.transitionId;
      const m = await this.render(n.problemId, t);
      if (m) await this.sendTo(n.problemId, m.kind, m.mail);
    } catch (e) {
      log('error', 'decision_mail_failed', {
        problemId: n.problemId,
        reason: e instanceof Error ? e.name : typeof e,
      });
    }
  }

  /** For callers outside the engine (re-moderation, reopen, reminder, appeal): send a rendered template. */
  async sendTo(
    problemId: string,
    kind: string,
    mail: Rendered,
  ): Promise<boolean> {
    try {
      const [p] = await this.db
        .select({ initiatorId: problem.initiatorId })
        .from(problem)
        .where(eq(problem.id, problemId));
      if (!p?.initiatorId) return false;
      return await this.accounts.sendToAccount(p.initiatorId, {
        ...mail,
        kind,
      });
    } catch (e) {
      log('error', 'decision_mail_failed', {
        problemId,
        kind,
        reason: e instanceof Error ? e.name : typeof e,
      });
      return false;
    }
  }

  private async render(problemId: string, t: string | undefined) {
    const link = `${config.appBaseUrl}/me/problems/${problemId}`;
    switch (t) {
      case 'T01':
        return { kind: 'problem_in_review', mail: inReview({ link }) };
      case 'T08':
      case 'T09':
        return {
          kind: 'problem_waiting',
          mail: waitingForCheck({ link }),
        };
      case 'T02':
        return { kind: 'problem_changes', mail: changesRequested({ link }) };
      case 'T04':
        return { kind: 'problem_published', mail: published({ link }) };
      case 'T05': {
        const [p] = await this.db
          .select({ purgeAfter: problem.purgeAfter })
          .from(problem)
          .where(eq(problem.id, problemId));
        const [d] = await this.db
          .select({ until: moderationDecision.appealableUntil })
          .from(moderationDecision)
          .where(
            and(
              eq(moderationDecision.targetType, 'problem'),
              eq(moderationDecision.targetId, problemId),
            ),
          )
          .orderBy(desc(moderationDecision.createdAt))
          .limit(1);
        if (!p?.purgeAfter || !d) return null;
        return {
          kind: 'problem_not_accepted',
          mail: notAccepted({
            link,
            deletionDate: p.purgeAfter,
            appealableUntil: d.until,
          }),
        };
      }
      default:
        return null;
    }
  }
}
