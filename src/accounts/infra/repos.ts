import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { account, invite, loginCode, session } from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';
import type {
  AccountRepo,
  InviteRepo,
  LoginCodeRepo,
  SessionRepo,
} from '../app/ports.js';
import { config } from '../../config.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';

/** Unique violation on the handle column, however deeply the driver wrapped it. */
function isHandleCollision(e: unknown): boolean {
  for (let x = e as any, i = 0; x && i < 4; x = x.cause, i++) {
    if (x.code === '23505' && /handle/.test(String(x.constraint))) return true;
  }
  return false;
}

const accountCols = {
  id: account.id,
  handle: account.handle,
  role: account.role,
  handleRegenerations: account.handleRegenerations,
};

export class DrizzleAccountRepo implements AccountRepo {
  constructor(private readonly tx: Tx) {}
  async findByEmailHmac(hmac: Buffer) {
    const [r] = await this.tx
      .select(accountCols)
      .from(account)
      .where(and(eq(account.emailHmac, hmac), isNull(account.deletedAt)));
    return r ?? null;
  }
  async findById(id: string) {
    const [r] = await this.tx
      .select(accountCols)
      .from(account)
      .where(eq(account.id, id));
    return r ?? null;
  }
  // A savepoint keeps the outer transaction alive after a unique violation.
  async insert(a: Parameters<AccountRepo['insert']>[0]) {
    try {
      await this.tx.transaction((t) =>
        t.insert(account).values({
          ...a,
          originNodeId: config.nodeId,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
      return true;
    } catch (e) {
      if (isHandleCollision(e)) return false;
      throw e;
    }
  }
  async setHandle(id: string, handle: string) {
    try {
      await this.tx.transaction((t) =>
        t
          .update(account)
          .set({
            handle,
            handleRegenerations: sql`${account.handleRegenerations} + 1`,
          })
          .where(eq(account.id, id)),
      );
      return true;
    } catch (e) {
      if (isHandleCollision(e)) return false;
      throw e;
    }
  }
}

export class DrizzleInviteRepo implements InviteRepo {
  constructor(private readonly tx: Tx) {}
  async findByHash(hash: Buffer) {
    const [r] = await this.tx
      .select({
        id: invite.id,
        expiresAt: invite.expiresAt,
        redeemedAt: invite.redeemedAt,
      })
      .from(invite)
      .where(eq(invite.codeHash, hash));
    return r ?? null;
  }
  async redeem(id: string, accountId: string, now: Date) {
    const r = await this.tx
      .update(invite)
      .set({ redeemedBy: accountId, redeemedAt: now })
      .where(
        and(
          eq(invite.id, id),
          isNull(invite.redeemedAt),
          gt(invite.expiresAt, now),
        ),
      )
      .returning({ id: invite.id });
    return r.length === 1;
  }
}

export class DrizzleLoginCodeRepo implements LoginCodeRepo {
  constructor(private readonly tx: Tx) {}
  async invalidateOpen(accountId: string, now: Date) {
    await this.tx
      .update(loginCode)
      .set({ consumedAt: now })
      .where(
        and(eq(loginCode.accountId, accountId), isNull(loginCode.consumedAt)),
      );
  }
  async insert(c: Parameters<LoginCodeRepo['insert']>[0]) {
    await this.tx.insert(loginCode).values(c);
  }
  async findActive(accountId: string, now: Date, maxAttempts: number) {
    const [r] = await this.tx
      .select({
        id: loginCode.id,
        codeHash: loginCode.codeHash,
        attempts: loginCode.attempts,
      })
      .from(loginCode)
      .where(
        and(
          eq(loginCode.accountId, accountId),
          isNull(loginCode.consumedAt),
          gt(loginCode.expiresAt, now),
          lt(loginCode.attempts, maxAttempts),
        ),
      )
      .orderBy(desc(loginCode.expiresAt))
      .limit(1);
    return r ?? null;
  }
  async addAttempt(id: string) {
    const [r] = await this.tx
      .update(loginCode)
      .set({ attempts: sql`${loginCode.attempts} + 1` })
      .where(eq(loginCode.id, id))
      .returning({ attempts: loginCode.attempts });
    return r!.attempts;
  }
  async consume(id: string, now: Date) {
    const r = await this.tx
      .update(loginCode)
      .set({ consumedAt: now })
      .where(and(eq(loginCode.id, id), isNull(loginCode.consumedAt)))
      .returning({ id: loginCode.id });
    return r.length === 1;
  }
}

export class DrizzleSessionRepo implements SessionRepo {
  constructor(private readonly tx: Tx) {}
  async insert(s: Parameters<SessionRepo['insert']>[0]) {
    await this.tx.insert(session).values(s);
  }
  async findByHash(tokenHash: Buffer) {
    const [r] = await this.tx
      .select({
        id: session.id,
        accountId: session.accountId,
        role: account.role,
        handle: account.handle,
        expiresAt: session.expiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        revokedAt: session.revokedAt,
        lastSeenAt: session.lastSeenAt,
        deletedAt: account.deletedAt,
      })
      .from(session)
      .innerJoin(account, eq(account.id, session.accountId))
      .where(eq(session.tokenHash, tokenHash));
    if (!r) return null;
    const { deletedAt, ...rest } = r;
    return { ...rest, accountDeleted: deletedAt !== null };
  }
  async touch(id: string, lastSeenAt: Date, expiresAt: Date) {
    await this.tx
      .update(session)
      .set({ lastSeenAt, expiresAt })
      .where(eq(session.id, id));
  }
  async revoke(tokenHash: Buffer, now: Date) {
    await this.tx
      .update(session)
      .set({ revokedAt: now })
      .where(and(eq(session.tokenHash, tokenHash), isNull(session.revokedAt)));
  }
}
