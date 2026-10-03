import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { contribution, problem } from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';
import { ApiException } from '../../platform/errors.js';
import { CLOCK, type Clock } from '../../platform/ports.js';
import { PolicyStore } from '../../policy/app/policy-store.js';
import {
  replyAllowance,
  replyCapFrom,
  replyWindowStart,
  type ReplyCap,
} from '../domain/reply-cap.js';

export const activeReplyCap = (store: PolicyStore): ReplyCap =>
  replyCapFrom(store.active('default').limits);

/** createdAt of every reply by the account on the problem inside the window. Rows are never deleted on withdraw or removal, so they keep counting. */
const counted = async (
  q: Tx | Db,
  a: { accountId: string; problemId: string },
  now: Date,
  cap: ReplyCap,
) =>
  (
    await q
      .select({ at: contribution.createdAt })
      .from(contribution)
      .where(
        and(
          eq(contribution.authorId, a.accountId),
          eq(contribution.problemId, a.problemId),
          gt(contribution.createdAt, replyWindowStart(now, cap)),
        ),
      )
  ).map((r) => r.at);

/**
 * Call inside the submit transaction, before the insert. The per-account-per-problem advisory lock
 * serialises concurrent submits so they cannot exceed the cap. System actors have no author_id: skip this.
 */
export async function enforceReplyCap(
  tx: Tx,
  a: { accountId: string; problemId: string },
  now: Date,
  cap: ReplyCap,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`reply_cap:${a.accountId}:${a.problemId}`}))`,
  );
  const al = replyAllowance(cap, await counted(tx, a, now, cap));
  if (al.remaining > 0) return;
  throw new ApiException(
    429,
    'reply_limit_reached',
    `You can post ${al.limit} ${al.limit === 1 ? 'reply' : 'replies'} on one problem every ${cap.days === 1 ? '24 hours' : `${cap.days} days`}. You can reply again later.`,
    undefined,
    { limit: al.limit, remaining: 0, resetsAt: al.resetsAt },
  );
}

@Injectable()
export class ReplyAllowanceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PolicyStore) private readonly store: PolicyStore,
  ) {}

  async get(accountId: string, problemId: string) {
    const [p] = await this.db
      .select({ id: problem.id })
      .from(problem)
      .where(eq(problem.id, problemId));
    if (!p) throw new ApiException(404, 'not_found', 'Problem not found');
    const cap = activeReplyCap(this.store);
    return replyAllowance(
      cap,
      await counted(this.db, { accountId, problemId }, this.clock.now(), cap),
    );
  }
}
