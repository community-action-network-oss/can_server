import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import * as schema from '../src/db/schema.js';
import { FingerprintRepo } from '../src/problems/infra/fingerprint.repo.js';
import { FixedClock } from '../src/platform/testing.js';
import pairs from './fixtures/reposts.json' with { type: 'json' };

let pool: pg.Pool;
let repo: FingerprintRepo;
const clock = new FixedClock(new Date('2031-01-01T00:00:00Z'));
const near = pairs.find((p) => p.similar)!;
const far = pairs.findLast((p) => !p.similar)!;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  repo = new FingerprintRepo(drizzle(pool, { schema }));
});
afterAll(async () => {
  // Rows carry no owner; this run's far-future clock identifies them.
  await pool.query(`delete from draft_fingerprint where created_at >= '2031-01-01'`);
  await pool.end();
});

describe('draft fingerprint repo', () => {
  it('matches a near duplicate and not an unrelated text', async () => {
    await repo.store(repo.sketch(near.a), 'rejected', clock.now());
    expect(await repo.findSimilar(repo.sketch(near.b), clock.now())).toBe(true);
    expect(await repo.findSimilar(repo.sketch(far.b), clock.now())).toBe(false);
  });

  it('expires after 90 days and purgeExpired removes the row', async () => {
    const day = (n: number) => new Date(clock.now().getTime() + n * 86_400_000);
    expect(await repo.findSimilar(repo.sketch(near.b), day(89))).toBe(true);
    expect(await repo.findSimilar(repo.sketch(near.b), day(91))).toBe(false);
    expect(await repo.purgeExpired(day(91))).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(
      `select count(*)::int n from draft_fingerprint where created_at >= '2031-01-01'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('deleteMatching removes only matching rows', async () => {
    await repo.store(repo.sketch(near.a), 'withdrawn', clock.now());
    await repo.store(repo.sketch(far.a), 'withdrawn', clock.now());
    expect(await repo.deleteMatching(repo.sketch(near.b), clock.now())).toBe(1);
    expect(await repo.findSimilar(repo.sketch(far.a), clock.now())).toBe(true);
    await repo.deleteMatching(repo.sketch(far.a), clock.now());
  });

  it('table has no foreign keys and no text, account or problem columns', async () => {
    const fks = await pool.query(
      `select 1 from information_schema.table_constraints where table_name='draft_fingerprint' and constraint_type='FOREIGN KEY'`,
    );
    expect(fks.rowCount).toBe(0);
    const cols = await pool.query(
      `select column_name from information_schema.columns where table_name='draft_fingerprint' order by 1`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      'created_at', 'expires_at', 'hashes', 'id', 'reason',
    ]);
  });
});
