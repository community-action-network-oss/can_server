import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module.js';
import { consentRecord, follow, notification, problem } from '../db/schema.js';
import { isPublicState, type State } from '../domain/lifecycle/vocabulary.js';
import { ApiException } from '../platform/errors.js';
import {
  decodeCursor,
  encodeCursor,
  type Page,
} from '../platform/pagination.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../platform/ports.js';
import { PURPOSE } from './notification-kinds.js';

const nf = () => new ApiException(404, 'not_found', 'Not found.');

/** Follows, consent and the in-app list (04-u07). Every method is scoped to the caller's account id. */
@Injectable()
export class FollowsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /** Opt in (or change the email choice). Only a public problem can be followed; anything else is a 404. */
  async follow(accountId: string, problemId: string, emailUpdates: boolean) {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const [p] = await tx
        .select({ state: problem.state, wp: problem.withdrawnPublished })
        .from(problem)
        .where(eq(problem.id, problemId));
      if (!p || !isPublicState(p.state as State, p.wp)) throw nf();
      if (emailUpdates) {
        // Serialise per account so two parallel opt-ins create one active consent row.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${accountId}))`,
        );
        const [c] = await tx
          .select({ id: consentRecord.id })
          .from(consentRecord)
          .where(
            and(
              eq(consentRecord.accountId, accountId),
              eq(consentRecord.purpose, PURPOSE),
              isNull(consentRecord.revokedAt),
            ),
          );
        if (!c)
          await tx.insert(consentRecord).values({
            id: this.ids.next(),
            accountId,
            purpose: PURPOSE,
            grantedAt: now,
          });
      }
      const [f] = await tx
        .select({ at: follow.mailConsentAt })
        .from(follow)
        .where(
          and(eq(follow.accountId, accountId), eq(follow.problemId, problemId)),
        );
      const consentAt = emailUpdates ? (f?.at ?? now) : null;
      await tx
        .insert(follow)
        .values({
          accountId,
          problemId,
          createdAt: now,
          mailConsentAt: consentAt,
        })
        .onConflictDoUpdate({
          target: [follow.accountId, follow.problemId],
          set: { mailConsentAt: consentAt },
        });
    });
    return this.one(accountId, problemId);
  }

  async unfollow(accountId: string, problemId: string): Promise<void> {
    await this.db
      .delete(follow)
      .where(
        and(eq(follow.accountId, accountId), eq(follow.problemId, problemId)),
      );
  }

  async mute(accountId: string, problemId: string, muted: boolean) {
    const r = await this.db
      .update(follow)
      .set({ mutedAt: muted ? this.clock.now() : null })
      .where(
        and(eq(follow.accountId, accountId), eq(follow.problemId, problemId)),
      )
      .returning({ p: follow.problemId });
    if (!r.length) throw nf();
    return this.one(accountId, problemId);
  }

  /** Stops every follow email of this account at once (NOTIFY-CONSENT-1). Follows and in-app items stay. */
  async revokeEmailConsent(accountId: string): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      await tx
        .update(consentRecord)
        .set({ revokedAt: now })
        .where(
          and(
            eq(consentRecord.accountId, accountId),
            eq(consentRecord.purpose, PURPOSE),
            isNull(consentRecord.revokedAt),
          ),
        );
      await tx
        .update(follow)
        .set({ mailConsentAt: null })
        .where(eq(follow.accountId, accountId));
    });
  }

  async mine(accountId: string) {
    const rows = await this.db
      .select(FOLLOW_COLS)
      .from(follow)
      .innerJoin(problem, eq(problem.id, follow.problemId))
      .where(eq(follow.accountId, accountId))
      .orderBy(desc(follow.createdAt), desc(follow.problemId));
    return { items: rows.map(dto) };
  }

  private async one(accountId: string, problemId: string) {
    const [r] = await this.db
      .select(FOLLOW_COLS)
      .from(follow)
      .innerJoin(problem, eq(problem.id, follow.problemId))
      .where(
        and(eq(follow.accountId, accountId), eq(follow.problemId, problemId)),
      );
    return dto(r!);
  }

  async notifications(
    accountId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<ReturnType<typeof nDto>>> {
    let before: ReturnType<typeof sql> | undefined;
    if (cursor) {
      const c = decodeCursor(cursor);
      const at = typeof c.at === 'string' ? new Date(c.at) : null;
      if (!at || Number.isNaN(at.getTime()) || typeof c.id !== 'string')
        throw new ApiException(400, 'validation_failed', 'Invalid cursor', {
          cursor: 'Invalid cursor',
        });
      before = or(
        lt(notification.createdAt, at),
        and(eq(notification.createdAt, at), lt(notification.id, c.id)),
      );
    }
    const rows = await this.db
      .select({
        id: notification.id,
        problemId: notification.problemId,
        kind: notification.kind,
        label: notification.label,
        createdAt: notification.createdAt,
        readAt: notification.readAt,
        title: problem.title,
      })
      .from(notification)
      .innerJoin(problem, eq(problem.id, notification.problemId))
      .where(and(eq(notification.accountId, accountId), before))
      .orderBy(desc(notification.createdAt), desc(notification.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items: items.map(nDto),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ at: last.createdAt!.toISOString(), id: last.id })
          : null,
    };
  }

  async markRead(accountId: string, id: string): Promise<void> {
    const r = await this.db
      .update(notification)
      .set({
        readAt: sql`coalesce(${notification.readAt}, ${this.clock.now()})`,
      })
      .where(
        and(eq(notification.id, id), eq(notification.accountId, accountId)),
      )
      .returning({ id: notification.id });
    if (!r.length) throw nf();
  }

  async readAll(accountId: string): Promise<void> {
    await this.db
      .update(notification)
      .set({ readAt: this.clock.now() })
      .where(
        and(eq(notification.accountId, accountId), isNull(notification.readAt)),
      );
  }
}

const FOLLOW_COLS = {
  problemId: follow.problemId,
  title: problem.title,
  createdAt: follow.createdAt,
  mutedAt: follow.mutedAt,
  mailConsentAt: follow.mailConsentAt,
};
const dto = (r: {
  problemId: string;
  title: string | null;
  createdAt: Date;
  mutedAt: Date | null;
  mailConsentAt: Date | null;
}) => ({
  problemId: r.problemId,
  title: r.title,
  followedAt: r.createdAt.toISOString(),
  muted: r.mutedAt !== null,
  emailUpdates: r.mailConsentAt !== null,
});
const nDto = (r: {
  id: string;
  problemId: string;
  kind: string;
  label: string;
  createdAt: Date | null;
  readAt: Date | null;
  title: string | null;
}) => ({
  id: r.id,
  problemId: r.problemId,
  problemTitle: r.title,
  kind: r.kind,
  label: r.label,
  createdAt: r.createdAt!.toISOString(),
  read: r.readAt !== null,
});
