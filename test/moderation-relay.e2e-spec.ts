import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import * as schema from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { PROTOCOL_VERSION } from '../src/domain/protocol.js';
import { EventRelay } from '../src/moderation/app/event-relay.js';
import { DpRegistry } from '../src/moderation/app/dp-registry.js';
import { RelayCursor } from '../src/moderation/infra/relay-cursor.js';
import { AuditPort } from '../src/platform/audit/audit.service.js';
import { PgQueue } from '../src/platform/queue/pg-queue.js';
import { queueConfig } from '../src/platform/queue/queue.config.js';
import {
  QueuePort,
  type EnqueueInput,
} from '../src/platform/queue/queue.port.js';
import { SystemClock, UuidV7Generator } from '../src/platform/ports.js';
import { PolicyStore } from '../src/policy/app/policy-store.js';
import { FsPackSource } from '../src/policy/infra/fs-pack-source.js';
import { moderationFixtures } from './support/moderation-fixtures.ts';
import { ProblemFixtures } from './support/problems.js';

let pool: pg.Pool;
let fx: ProblemFixtures;
let failAt = 0; // fail the Nth enqueue of the next tick, once
let seen = 0;
let relay: EventRelay;
const ids = new UuidV7Generator();
const eventIds: string[] = [];
const cursors: string[] = [];
const later = () => new Date(Date.now() + 60_000);

class FlakyQueue extends QueuePort {
  constructor(private readonly inner: PgQueue) {
    super();
  }
  async enqueue(i: EnqueueInput): Promise<string> {
    if (failAt && ++seen === failAt) {
      failAt = 0;
      throw new Error('injected');
    }
    return this.inner.enqueue(i);
  }
  claim = (...a: Parameters<PgQueue['claim']>) => this.inner.claim(...a);
  ack = (...a: Parameters<PgQueue['ack']>) => this.inner.ack(...a);
  fail = (...a: Parameters<PgQueue['fail']>) => this.inner.fail(...a);
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  const db = drizzle(pool, { schema });
  fx = new ProblemFixtures(db);
  const m = moderationFixtures();
  const src = new FsPackSource(m.dir);
  const store = new PolicyStore(src);
  await store.activate('default', {
    name: 'fiktiva-city',
    version: '1.0.0',
    hash: m.v1.hash,
  });
  const clock = new SystemClock();
  const pq = new PgQueue(
    db,
    clock,
    ids,
    { next: () => 1 },
    queueConfig,
    new AuditPort(clock, ids),
  );
  relay = new EventRelay(
    db,
    clock,
    ids,
    new FlakyQueue(pq),
    new RelayCursor(db),
    new DpRegistry(store, src),
  );
});
afterAll(async () => {
  if (eventIds.length)
    await pool.query(
      `delete from job where queue = 'moderation' and payload->>'eventId' = any($1)`,
      [eventIds],
    );
  await pool.query(`delete from moderation_event where id = any($1)`, [
    eventIds,
  ]);
  await pool.query(`delete from relay_cursor where name = any($1)`, [
    cursors.flatMap((c) => [
      `${c}:problem_event`,
      `${c}:stage_event`,
      `${c}:moderation_event`,
    ]),
  ]);
  await fx.cleanup();
  await pool.end();
});

/** A fresh cursor, initialised at the newest existing event so only this test's events are read. */
async function cursor(): Promise<string> {
  const c = `t-${newId()}`;
  cursors.push(c);
  await relay.tick({ cursor: c, now: later() });
  return c;
}
async function pe(
  problemId: string,
  type: string,
  payload: Record<string, unknown>,
  state: string | null = null,
): Promise<string> {
  const id = newId();
  eventIds.push(id);
  await pool.query(
    `insert into problem_event (id, problem_id, type, to_state, payload, origin_node_id, protocol_version, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7, now() - interval '1 minute')`,
    [id, problemId, type, state, payload, config.nodeId, PROTOCOL_VERSION],
  );
  return id;
}
async function jobs(eventId: string) {
  const r = await pool.query(
    `select class, payload, dedupe_key from job where queue = 'moderation' and payload->>'eventId' = $1`,
    [eventId],
  );
  return r.rows as {
    class: string;
    payload: Record<string, unknown>;
    dedupe_key: string;
  }[];
}
const dpIds = (js: { payload: Record<string, unknown> }[]) =>
  js.map((j) => j.payload.dpId as string);

describe('EventRelay', () => {
  it('a T01 event enqueues one deduped job per DP, DP-CRISIS in the crisis class, ids only', async () => {
    const p = await fx.problem('in_review');
    const c = await cursor();
    const e = await pe(
      p,
      'state_changed',
      { transitionId: 'T01' },
      'in_review',
    );
    const r = await relay.tick({ cursor: c, now: later() });
    expect(r.enqueued).toBeGreaterThan(3);
    const js = await jobs(e);
    expect(js).toHaveLength(r.enqueued);
    expect(new Set(dpIds(js)).size).toBe(js.length);
    const crisis = js.find((j) => j.payload.dpId === 'DP-CRISIS')!;
    expect(crisis.class).toBe('crisis');
    expect(crisis.dedupe_key).toBe(`${e}:DP-CRISIS`);
    expect(crisis.payload).toMatchObject({
      eventKind: 'review_requested',
      trigger: 'submit_gate',
      targetKind: 'problem',
      targetId: p,
      targetVersion: 1,
    });
    expect(JSON.stringify(js)).not.toContain('Transition engine fixture');
    // A DP the pack lacks is still queued, flagged to hold.
    expect(js.some((j) => j.payload.holdReason === 'pack_missing')).toBe(true);
  });

  it('replaying the same events enqueues nothing new', async () => {
    const p = await fx.problem('in_review');
    const c = await cursor();
    const e = await pe(
      p,
      'state_changed',
      { transitionId: 'T01' },
      'in_review',
    );
    await relay.tick({ cursor: c, now: later() });
    const before = (await jobs(e)).length;
    expect((await relay.tick({ cursor: c, now: later() })).seen).toBe(0);
    await pool.query(
      `update relay_cursor set last_id = null where name like $1`,
      [`${c}:%`],
    );
    await relay.tick({ cursor: c, now: later() });
    expect((await jobs(e)).length).toBe(before);
  });

  it('an edit enqueues only bound DPs plus the always set', async () => {
    const p = await fx.problem('active');
    const c = await cursor();
    const a = await pe(p, 'problem.edited', { changedFields: ['condition'] });
    const b = await pe(p, 'problem.edited', { changedFields: ['zzzUnbound'] });
    await relay.tick({ cursor: c, now: later() });
    const withTitle = dpIds(await jobs(a));
    const without = dpIds(await jobs(b));
    expect(withTitle).toContain('DP-NAMING');
    expect(without).not.toContain('DP-NAMING');
    expect(without).toContain('DP-CRISIS');
    expect(without.length).toBeLessThan(withTitle.length);
  });

  it('a stuck candidate queues DP-BLOCKER with the stage ids', async () => {
    const p = await fx.problem('active');
    const c = await cursor();
    const s = newId();
    const e = await pe(p, 'problem.stuck_candidate', {
      stageIds: [s],
      decisionPoint: 'DP-BLOCKER',
    });
    await relay.tick({ cursor: c, now: later() });
    const j = (await jobs(e)).find((x) => x.payload.dpId === 'DP-BLOCKER')!;
    expect(j.payload.stageIds).toEqual([s]);
  });

  it('unknown event types are ignored and counted', async () => {
    const p = await fx.problem('draft');
    const c = await cursor();
    const e = await pe(p, 'draft_schema_migrated', {});
    const r = await relay.tick({ cursor: c, now: later() });
    expect(r.ignored).toBeGreaterThanOrEqual(1);
    expect(await jobs(e)).toHaveLength(0);
  });

  it('policy_changed enqueues one fan-out job; sample_tick one sample job that holds on a missing DP', async () => {
    const c = await cursor();
    const pc = await relay.emit('policy_changed', {
      fromVersion: 'p@1.0.0',
      toVersion: 'p@1.1.0',
      scope: 'default',
    });
    const st = await relay.emit('sample_tick', {
      dpId: 'DP-RERESOLUTION',
      windowId: 'w1',
    });
    eventIds.push(pc, st);
    await relay.tick({ cursor: c, now: later() });
    const a = await jobs(pc);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ class: 'async' });
    expect(a[0]!.payload).toMatchObject({
      kind: 'policy_fanout',
      toVersion: 'p@1.1.0',
    });
    const b = await jobs(st);
    expect(b[0]).toMatchObject({ class: 'sample' });
    expect(b[0]!.payload.holdReason).toBe('pack_missing');
  });

  it('a failed tick loses nothing: the cursor stays and the retry completes without duplicates', async () => {
    const p = await fx.problem('in_review');
    const c = await cursor();
    const e = await pe(
      p,
      'state_changed',
      { transitionId: 'T01' },
      'in_review',
    );
    seen = 0;
    failAt = 3;
    await expect(relay.tick({ cursor: c, now: later() })).rejects.toThrow(
      'injected',
    );
    expect((await jobs(e)).length).toBe(2); // enqueued before the failure, cursor not moved
    const r = await relay.tick({ cursor: c, now: later() });
    expect(r.seen).toBe(1);
    const js = await jobs(e);
    expect(js).toHaveLength(r.enqueued);
    expect(new Set(dpIds(js)).size).toBe(js.length);
  });
});
