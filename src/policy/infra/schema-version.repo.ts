import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/db.module.js';
import { contentSchemaVersion as t } from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';

export type SchemaVersionRow = typeof t.$inferSelect;

export class SchemaVersionRepo {
  /** Records the active hash and retires every other hash of the type. Idempotent. */
  async activate(
    tx: Tx | Db,
    r: { type: string; version: string; packVersion: string; hash: string },
    now: Date,
  ): Promise<void> {
    // One writer at a time: concurrent activations would otherwise lock rows in opposite order.
    await tx.execute(sql`select pg_advisory_xact_lock(7129001)`);
    await tx
      .insert(t)
      .values({
        type: r.type,
        version: r.version,
        packVersion: r.packVersion,
        schemaHash: r.hash,
        activatedAt: now,
      })
      .onConflictDoUpdate({
        target: [t.type, t.schemaHash],
        set: { retiredAt: null, packVersion: r.packVersion }, // a pack bump that keeps the schema bytes must point validate at the pack now loaded
      });
    await tx
      .update(t)
      .set({ retiredAt: now })
      .where(
        and(eq(t.type, r.type), ne(t.schemaHash, r.hash), isNull(t.retiredAt)),
      );
  }

  async byHash(tx: Tx | Db, type: string, hash: string) {
    const [r] = await tx
      .select()
      .from(t)
      .where(and(eq(t.type, type), eq(t.schemaHash, hash)));
    return r;
  }

  /** Newest activation wins when a version string was reused with another hash. */
  async byVersion(tx: Tx | Db, type: string, version: string) {
    const [r] = await tx
      .select()
      .from(t)
      .where(and(eq(t.type, type), eq(t.version, version)))
      .orderBy(desc(t.activatedAt))
      .limit(1);
    return r;
  }
}
