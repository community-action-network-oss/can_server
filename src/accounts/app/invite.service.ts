import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { invite } from '../../db/schema.js';
import { withTransaction } from '../../db/tx.js';
import { AuditPort } from '../../platform/audit/audit.service.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import { hashSecret } from '../infra/crypto.js';
import { AUTH_SETTINGS, type AuthSettings } from './ports.js';

const DAY = 86_400_000;
// No 0/O/1/I/L so a code read aloud or copied by hand survives.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 16 random chars (about 79 bits) as XXXX-XXXX-XXXX-XXXX. */
export function newInviteCode(): string {
  const c = Array.from(
    { length: 16 },
    () => ALPHABET[randomInt(ALPHABET.length)],
  );
  return [0, 4, 8, 12].map((i) => c.slice(i, i + 4).join('')).join('-');
}

/** The invite table has no issued_at; ids are uuid v7, whose first 48 bits are unix ms. */
const issuedAtOf = (id: string) =>
  new Date(parseInt(id.replaceAll('-', '').slice(0, 12), 16));

export interface InviteListItem {
  id: string;
  issuedAt: Date;
  expiresAt: Date;
  redeemed: boolean;
}

@Injectable()
export class InviteService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AUTH_SETTINGS) private readonly s: AuthSettings,
    @Inject(AuditPort) private readonly audit: AuditPort,
  ) {}

  /** The plain code leaves this method once; only its keyed hash is stored. */
  async issue(stewardId: string, expiresInDays: number) {
    const code = newInviteCode();
    const id = this.ids.next();
    const expiresAt = new Date(
      this.clock.now().getTime() + expiresInDays * DAY,
    );
    await withTransaction(this.db, async (tx) => {
      await tx.insert(invite).values({
        id,
        codeHash: hashSecret(code, this.s.inviteKey),
        issuedBy: stewardId,
        expiresAt,
      });
      await this.audit.record(tx, {
        actorId: stewardId,
        action: 'invite.issued',
        subjectType: 'invite',
        subjectId: id,
        detail: { expiresInDays },
      });
    });
    return { code, expiresAt };
  }

  /** Admins see every invite, stewards their own. Newest first. */
  async list(actor: { accountId: string; role: string }) {
    const q = this.db
      .select({
        id: invite.id,
        expiresAt: invite.expiresAt,
        redeemedAt: invite.redeemedAt,
      })
      .from(invite);
    const rows = await (
      actor.role === 'admin' ? q : q.where(eq(invite.issuedBy, actor.accountId))
    ).orderBy(desc(invite.id));
    return rows.map((r): InviteListItem => ({
      id: r.id,
      issuedAt: issuedAtOf(r.id),
      expiresAt: r.expiresAt,
      redeemed: r.redeemedAt !== null,
    }));
  }
}
