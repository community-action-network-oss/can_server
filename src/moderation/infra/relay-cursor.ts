import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const SOURCE_TABLE = {
  problem_event: sql`problem_event`,
  stage_event: sql`stage_event`,
  moderation_event: sql`moderation_event`,
} as const;
const NIL = '00000000-0000-0000-0000-000000000000';
type Row = { last_id: string | null };

/** One cursor row per source. A new cursor starts at the newest existing event: history predates the pipeline. */
@Injectable()
export class RelayCursor {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Holds the cursor row locked (one relay at a time) while `fn` handles events after it.
   * `fn` returns the id it got through; a throw leaves the cursor where it was.
   */
  async advance(
    name: string,
    source: keyof typeof SOURCE_TABLE,
    fn: (after: string, tx: Tx) => Promise<string | null>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into relay_cursor (name, last_id)
        values (${name}, (select id from ${SOURCE_TABLE[source]} order by id desc limit 1))
        on conflict (name) do nothing`);
      const r = await tx.execute<Row>(
        sql`select last_id from relay_cursor where name = ${name} for update`,
      );
      const after = r.rows[0]?.last_id ?? NIL;
      const to = await fn(after, tx);
      if (to)
        await tx.execute(
          sql`update relay_cursor set last_id = ${to}, updated_at = now() where name = ${name}`,
        );
    });
  }
}
