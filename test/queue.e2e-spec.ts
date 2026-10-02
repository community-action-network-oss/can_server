import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import * as schema from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { AuditPort } from '../src/platform/audit/audit.service.js';
import { FixedClock } from '../src/platform/testing.js';
import { backoffMs } from '../src/platform/queue/backoff.js';
import { ClassBuckets } from '../src/platform/queue/bucket.js';
import { PgQueue } from '../src/platform/queue/pg-queue.js';
import { queueConfig } from '../src/platform/queue/queue.config.js';
import type { Random } from '../src/platform/queue/queue.port.js';
import { QueueWorker } from '../src/platform/queue/worker.js';
import { UuidV7Generator } from '../src/platform/ports.js';

const T0 = new Date('2026-10-03T00:00:00Z');
const fixedRnd = (v: number): Random => ({ next: () => v });

let pool: pg.Pool;
const clock = new FixedClock(T0);
const mk = (rnd: Random = fixedRnd(1), cfg = queueConfig) => {
  const db = drizzle(pool, { schema });
  const ids = new UuidV7Generator();
  return new PgQueue(db, clock, ids, rnd, cfg, new AuditPort(clock, ids));
};
const q = () => `t-${newId()}`;
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeAll(() => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
});
afterAll(async () => {
  await pool.query(`delete from job where queue like 't-%'`);
  await pool.end();
});

describe('queue', () => {
  it('dedupes while queued or running, frees the key once done', async () => {
    const pq = mk();
    const name = q();
    const k = `k-${newId()}`;
    const a = await pq.enqueue(
      { queue: name, class: 'update', payload: {}, dedupeKey: k },
      T0,
    );
    const b = await pq.enqueue(
      { queue: name, class: 'update', payload: {}, dedupeKey: k },
      T0,
    );
    expect(b).toBe(a);
    const [j] = await pq.claim(name, 1, T0);
    expect(
      await pq.enqueue(
        { queue: name, class: 'update', payload: {}, dedupeKey: k },
        T0,
      ),
    ).toBe(a);
    await pq.ack(j);
    const c = await pq.enqueue(
      { queue: name, class: 'update', payload: {}, dedupeKey: k },
      T0,
    );
    expect(c).not.toBe(a);
  });

  it('refuses payloads with secret-looking keys', async () => {
    await expect(
      mk().enqueue({ queue: q(), class: 'async', payload: { email: 'x' } }),
    ).rejects.toThrow(/secret key/);
  });

  it('orders crisis, prepub, update, async, sample, then priority, then run_at', async () => {
    const pq = mk();
    const name = q();
    for (const [c, p] of [
      ['sample', 1],
      ['update', 5],
      ['async', 1],
      ['prepub', 9],
      ['update', 2],
      ['crisis', 50],
    ] as const)
      await pq.enqueue(
        { queue: name, class: c, priority: p, payload: { c, p } },
        T0,
      );
    const got = await pq.claim(name, 6, T0);
    expect(got.map((j) => `${j.class}${j.priority}`)).toEqual([
      'crisis50',
      'prepub9',
      'update2',
      'update5',
      'async1',
      'sample1',
    ]);
  });

  it('does not hand out jobs before run_at', async () => {
    const pq = mk();
    const name = q();
    await pq.enqueue(
      { queue: name, class: 'update', payload: {}, runAt: at(5000) },
      T0,
    );
    expect(await pq.claim(name, 5, T0)).toHaveLength(0);
    expect(await pq.claim(name, 5, at(5000))).toHaveLength(1);
  });

  it('two claimers never get the same job', async () => {
    const a = mk();
    const b = mk();
    const name = q();
    for (let i = 0; i < 30; i++)
      await a.enqueue({ queue: name, class: 'update', payload: { i } }, T0);
    const rounds = await Promise.all(
      Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).claim(name, 10, T0)),
    );
    const ids = rounds.flat().map((j) => j.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  it('two workers run each job once', async () => {
    const name = q();
    const cfg = { ...queueConfig, concurrency: 3 };
    const w = [mk(fixedRnd(1), cfg), mk(fixedRnd(1), cfg)].map(
      (p) => new QueueWorker(p, cfg),
    );
    const seen: string[] = [];
    for (const x of w)
      x.register(name, async (j) => {
        seen.push(j.id);
        await new Promise((r) => setTimeout(r, 5));
      });
    const pq = mk();
    for (let i = 0; i < 20; i++)
      await pq.enqueue(
        { queue: name, class: 'async', payload: { i } },
        new Date(),
      );
    clock.set(new Date(Date.now() + 1000));
    await Promise.all(w.map((x) => x.drain(name)));
    clock.set(T0);
    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
  });

  it('a lapsed lease makes the job claimable again; the old holder cannot ack', async () => {
    const pq = mk();
    const name = q();
    await pq.enqueue({ queue: name, class: 'prepub', payload: {} }, T0);
    const [first] = await pq.claim(name, 1, T0);
    expect(await pq.claim(name, 1, at(queueConfig.leaseMs - 1))).toHaveLength(
      0,
    );
    const [second] = await pq.claim(name, 1, at(queueConfig.leaseMs + 1));
    expect(second.id).toBe(first.id);
    expect(second.attempt).toBe(2);
    expect(await pq.ack(first)).toBe(false);
    expect(await pq.ack(second)).toBe(true);
  });

  it('retries with capped exponential backoff, then dies with a job.dead audit event', async () => {
    const pq = mk(fixedRnd(1));
    const name = q();
    const id = await pq.enqueue(
      { queue: name, class: 'update', payload: {}, maxAttempts: 3 },
      T0,
    );
    let now = T0;
    for (const delay of [1000, 2000]) {
      const [j] = await pq.claim(name, 1, now);
      await pq.fail(j, 'provider_timeout', now);
      expect(
        await pq.claim(name, 1, at(now.getTime() - T0.getTime() + delay - 1)),
      ).toHaveLength(0);
      now = at(now.getTime() - T0.getTime() + delay);
    }
    const [last] = await pq.claim(name, 1, now);
    expect(last.attempt).toBe(3);
    await pq.fail(last, 'Contains user text!', now);
    const row = (
      await pool.query('select status,last_error_code from job where id=$1', [
        id,
      ])
    ).rows[0];
    expect(row).toEqual({ status: 'dead', last_error_code: 'unknown' });
    const ev = await pool.query(
      `select detail from audit_event where action='job.dead' and subject_id=$1`,
      [id],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].detail).toMatchObject({ queue: name, attempt: 3 });
    expect(await pq.claim(name, 5, at(3_600_000))).toHaveLength(0);
  });

  it('a job whose lease lapsed on its last attempt goes dead on the next claim', async () => {
    const pq = mk();
    const name = q();
    const id = await pq.enqueue(
      { queue: name, class: 'update', payload: {}, maxAttempts: 1 },
      T0,
    );
    await pq.claim(name, 1, T0);
    expect(await pq.claim(name, 1, at(queueConfig.leaseMs + 1))).toHaveLength(
      0,
    );
    const r = await pool.query(
      'select status,last_error_code from job where id=$1',
      [id],
    );
    expect(r.rows[0]).toEqual({
      status: 'dead',
      last_error_code: 'lease_expired',
    });
  });

  it('async work gets its minimum share under a flood of prepub jobs', async () => {
    const pq = mk();
    const name = q();
    for (let i = 0; i < 20; i++)
      await pq.enqueue({ queue: name, class: 'prepub', payload: { i } }, T0);
    for (let i = 0; i < 3; i++)
      await pq.enqueue(
        { queue: name, class: i ? 'sample' : 'async', payload: { i } },
        T0,
      );
    const got = await pq.claim(name, 10, T0);
    expect(got).toHaveLength(10);
    expect(
      got.filter((j) => j.class === 'async' || j.class === 'sample'),
    ).toHaveLength(2);
    expect(got[0].class).toBe('prepub');
  });
});

describe('backoff and bucket (pure)', () => {
  it('doubles, caps at 15 minutes, jitter stays within [d/2, d]', () => {
    expect([1, 2, 3].map((a) => backoffMs(a, fixedRnd(1)))).toEqual([
      1000, 2000, 4000,
    ]);
    expect(backoffMs(30, fixedRnd(1))).toBe(900_000);
    expect(backoffMs(30, fixedRnd(0))).toBe(450_000);
  });
  it('token bucket refills on the clock', () => {
    const c = new FixedClock(T0);
    const b = new ClassBuckets({ sample: { capacity: 2, refillPerSec: 1 } }, c);
    expect([
      b.tryTake('sample'),
      b.tryTake('sample'),
      b.tryTake('sample'),
    ]).toEqual([true, true, false]);
    c.set(at(1000));
    expect(b.tryTake('sample')).toBe(true);
    expect(b.tryTake('sample')).toBe(false);
    expect(b.tryTake('crisis')).toBe(true);
  });
});
