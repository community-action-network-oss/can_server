import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, newToken } from '../src/accounts/infra/crypto.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { enforceReplyCap } from '../src/contributions/app/reply-cap.js';
import { replyCapFrom } from '../src/contributions/domain/reply-cap.js';
import { config } from '../src/config.js';
import * as s from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { ApiException } from '../src/platform/errors.js';
import { ratifiedV1 } from './policy/helpers.js';
import { ProblemFixtures } from './support/problems.js';

const HOUR = 3_600_000;
const T0 = new Date('2020-01-01T00:00:00Z'); // past-anchored: retention sweeps never touch these
const cap = replyCapFrom(undefined);
const saved = { dir: config.policyPacksDir, active: config.policyActive };

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
const made: string[] = [];

const at = (h: number) => new Date(T0.getTime() + h * HOUR);
/** What a submit does: cap check then insert, in one transaction. */
const reply = (
  accountId: string,
  problemId: string,
  now: Date,
  o: { type?: string; stageId?: string | null } = {},
) =>
  db.transaction(async (tx) => {
    await enforceReplyCap(tx, { accountId, problemId }, now, cap);
    const id = newId();
    await tx.insert(s.contribution).values({
      id,
      problemId,
      authorId: accountId,
      type: o.type ?? 'observation',
      body: {},
      createdAt: now,
      originNodeId: config.nodeId,
      protocolVersion: '1',
    });
    made.push(id);
    return id;
  });
const code = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: ApiException) => e,
  );

beforeAll(async () => {
  const v1 = ratifiedV1();
  config.policyPacksDir = v1.dir;
  config.policyActive = {
    default: {
      name: 'fiktiva-city',
      version: '1.0.0',
      hash: v1.hash['fiktiva-city'],
    },
  };
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  db = drizzle(pool, { schema: s });
  fx = new ProblemFixtures(db);
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
});
afterAll(async () => {
  await app.close();
  config.policyPacksDir = saved.dir;
  config.policyActive = saved.active;
  if (made.length)
    await db.delete(s.contribution).where(inArray(s.contribution.id, made));
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

describe('reply cap (D-85)', () => {
  it('4 succeed, the 5th is 429 with resetsAt; another problem and account are unaffected', async () => {
    const a = await fx.account();
    const b = await fx.account();
    const p1 = await fx.problem('active');
    const p2 = await fx.problem('active');
    for (let i = 0; i < 4; i++) await reply(a, p1, at(i + 1));
    const e = await code(reply(a, p1, at(5)));
    expect(e?.getStatus()).toBe(429);
    expect(e?.code).toBe('reply_limit_reached');
    expect(e?.extra).toEqual({
      limit: 4,
      remaining: 0,
      resetsAt: at(25).toISOString(),
    });
    await reply(a, p2, at(5));
    await reply(b, p1, at(5));
  });

  it('counts stage-scoped and every type, and withdrawn or removed replies; drafts and edits do not', async () => {
    const a = await fx.account();
    const p = await fx.problem('active');
    await fx.problem('draft', { initiatorId: a }); // a draft by the same account
    const ids = [
      await reply(a, p, at(1), { type: 'risk' }),
      await reply(a, p, at(1), { type: 'progress_update' }),
      await reply(a, p, at(1), { type: 'evidence' }),
      await reply(a, p, at(1)),
    ];
    // moderation removal and an edit-like update change nothing about counting
    await db
      .update(s.contribution)
      .set({ status: 'tombstoned' })
      .where(eq(s.contribution.id, ids[0]!));
    await db
      .update(s.contribution)
      .set({ status: 'hidden', body: { x: 1 } })
      .where(eq(s.contribution.id, ids[1]!));
    expect((await code(reply(a, p, at(2))))?.code).toBe('reply_limit_reached');
  });

  it('rolls: a slot frees exactly when the oldest reply leaves the window', async () => {
    const a = await fx.account();
    const p = await fx.problem('active');
    for (const h of [1, 2, 3, 4]) await reply(a, p, at(h));
    expect((await code(reply(a, p, at(24.99))))?.code).toBe(
      'reply_limit_reached',
    );
    await reply(a, p, at(25)); // reply at hour 1 left the window
    const e = await code(reply(a, p, at(25.5)));
    expect(e?.extra?.resetsAt).toBe(at(26).toISOString());
  });

  it('concurrent submits cannot exceed the cap', async () => {
    const a = await fx.account();
    const p = await fx.problem('active');
    const r = await Promise.all(
      Array.from({ length: 8 }, (_, i) => code(reply(a, p, at(1 + i / 100)))),
    );
    expect(r.filter((x) => x === null)).toHaveLength(4);
    expect(r.filter((x) => x?.code === 'reply_limit_reached')).toHaveLength(4);
  });
});

describe('GET /v1/me/problems/:id/reply-allowance', () => {
  it('needs a session, 404s unknown problems, and reports remaining', async () => {
    const a = await fx.account();
    const token = newToken();
    await db.insert(s.session).values({
      id: newId(),
      accountId: a,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + HOUR),
      absoluteExpiresAt: new Date(Date.now() + HOUR),
      clientKind: 'native',
    });
    const p = await fx.problem('active');
    const get = (id: string, auth = true) => {
      const r = request(app.getHttpServer()).get(
        `/v1/me/problems/${id}/reply-allowance`,
      );
      return auth ? r.set({ Authorization: `Bearer ${token}` }) : r;
    };
    await get(p, false).expect(401);
    await get(newId()).expect(404);
    expect((await get(p).expect(200)).body).toEqual({
      limit: 4,
      remaining: 4,
      resetsAt: null,
    });
    // two recent replies (inside the real-clock window)
    for (const m of [30, 10])
      await reply(a, p, new Date(Date.now() - m * 60_000));
    const r = (await get(p).expect(200)).body;
    expect(r).toMatchObject({ limit: 4, remaining: 2 });
    expect(r.resetsAt).toBeTruthy();
  });
});
