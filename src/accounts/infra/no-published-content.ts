import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { problem } from '../../db/schema.js';
import type { HasPublishedContent } from '../app/ports.js';

/** True when the account initiated a problem that was ever published (OWN-1 keeps this the only link). */
@Injectable()
export class NoPublishedContent implements HasPublishedContent {
  constructor(@Inject(DB) private readonly db: Db) {}
  async check(accountId: string): Promise<boolean> {
    const [r] = await this.db
      .select({ one: sql`1` })
      .from(problem)
      .where(
        and(eq(problem.initiatorId, accountId), isNotNull(problem.publishedAt)),
      )
      .limit(1);
    return !!r;
  }
}
