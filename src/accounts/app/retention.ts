import { Inject, Injectable } from '@nestjs/common';
import { lte, or } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { loginCode, session } from '../../db/schema.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Retention table: sessions 30 days past expiry or revoke, login codes 24 hours past expiry or use. */
@Injectable()
export class AuthRetention {
  constructor(@Inject(DB) private readonly db: Db) {}

  async cleanupAuth(now: Date): Promise<{ sessions: number; codes: number }> {
    const s = new Date(now.getTime() - 30 * DAY);
    const c = new Date(now.getTime() - 24 * HOUR);
    const sessions = await this.db
      .delete(session)
      .where(
        or(
          lte(session.expiresAt, s),
          lte(session.absoluteExpiresAt, s),
          lte(session.revokedAt, s),
        ),
      )
      .returning({ id: session.id });
    const codes = await this.db
      .delete(loginCode)
      .where(or(lte(loginCode.expiresAt, c), lte(loginCode.consumedAt, c)))
      .returning({ id: loginCode.id });
    return { sessions: sessions.length, codes: codes.length };
  }
}
