import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, newToken } from '../src/accounts/infra/crypto.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { config } from '../src/config.js';
import * as s from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { allowedTransitions } from '../src/domain/lifecycle/guard.js';
import { ProblemFixtures } from './support/problems.js';

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
const tokens: Record<string, string> = {};
let alice: string;
let bob: string;

async function signedIn(): Promise<string> {
  const id = await fx.account();
  const token = newToken();
  tokens[id] = token;
  await db.insert(s.session).values({
    id: newId(),
    accountId: id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000),
    clientKind: 'native',
  });
  return id;
}
const as = (acct: string) => ({ Authorization: `Bearer ${tokens[acct]}` });
const http = () => request(app.getHttpServer());
const mine = (state: string, o: Partial<typeof s.problem.$inferInsert> = {}) =>
  fx.problem(state, {
    initiatorId: alice,
    ...(['draft', 'in_review', 'needs_revision', 'held'].includes(state)
      ? {}
      : { publishedAt: new Date() }),
    ...o,
  });
const move = (id: string, who: string | null, body: object) => {
  const r = http().post(`/v1/drafts/${id}/transitions`);
  return (who ? r.set(as(who)) : r).send(body);
};
const row = async (id: string) =>
  (await db.select().from(s.problem).where(eq(s.problem.id, id)))[0]!;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  db = drizzle(pool, { schema: s });
  fx = new ProblemFixtures(db);
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  alice = await signedIn();
  bob = await signedIn();
});
afterAll(async () => {
  await app.close();
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

describe('POST /v1/drafts/:id/transitions', () => {
  it('guest 401; other member 403 on a public problem, 404 on a private one', async () => {
    const pub = await mine('active');
    const priv = await mine('draft');
    await move(pub, null, { to: 'paused' }).expect(401);
    await move(pub, bob, { to: 'paused' }).expect(403);
    await move(priv, bob, { to: 'in_review' }).expect(404);
  });

  it('wrong state 409; missing fields 400 naming them', async () => {
    const d = await mine('draft');
    const r = await move(d, alice, { to: 'paused' }).expect(409);
    expect(r.body.error.code).toBe('invalid_transition');
    const a = await mine('active');
    const m = await move(a, alice, { to: 'paused' }).expect(400);
    expect(Object.keys(m.body.error.fieldErrors).sort()).toEqual(
      ['resumeCondition', 'reasonCode', 'reviewDate'].sort(),
    );
  });

  it('run-decided and system moves are refused for the author', async () => {
    const r = await mine('in_review');
    await move(r, alice, { to: 'active' }).expect(403); // T04
    await move(r, alice, { to: 'needs_revision' }).expect(403); // T02
    await move(r, alice, { to: 'rejected' }).expect(403); // T05
    await move(r, alice, { to: 'held' }).expect(403); // T09
    const a = await mine('active');
    await move(a, alice, {
      to: 'solved',
      fields: { criteriaEvidence: ['e'], outcomeStatement: 'o' },
    }).expect(403); // T15 direct: propose only
    expect((await row(r)).state).toBe('in_review');
  });

  it('submit stays refused until the checks are wired', async () => {
    const d = await mine('draft');
    const r = await move(d, alice, { to: 'in_review' }).expect(403);
    expect(r.body.error.message).toBe('checks not wired');
    expect((await row(d)).state).toBe('draft');
  });

  it('direct move: author withdraws from review (T06) and the version moves', async () => {
    const r = await mine('in_review');
    const res = await move(r, alice, { to: 'withdrawn' }).expect(200);
    expect(res.body).toMatchObject({
      id: r,
      state: 'withdrawn',
      label: expect.any(String),
      version: 2,
      pending: null,
    });
    await move(r, alice, { to: 'withdrawn', expectedVersion: 1 }).expect(409);
  });

  it('propose T16 records a pending proposal without changing state', async () => {
    const a = await mine('active');
    const res = await move(a, alice, {
      to: 'closed',
      action: 'propose',
      fields: { reasonCode: 'resolved_elsewhere', explanation: 'x' },
    }).expect(200);
    const handle = (
      await db.select().from(s.account).where(eq(s.account.id, alice))
    )[0]!.handle;
    expect(res.body).toMatchObject({
      state: 'active',
      pending: { to: 'closed', proposedBy: handle },
    });
    expect((await row(a)).state).toBe('active');
    expect((await row(a)).pendingTransition).toBeTruthy();
  });

  it('rejects unknown body keys and bad targets', async () => {
    const a = await mine('active');
    await move(a, alice, { to: 'nowhere' }).expect(400);
    await move(a, alice, { to: 'paused', actor: 'run' }).expect(400);
  });
});

describe('GET /v1/drafts/:id/actions', () => {
  const expected = (from: string) =>
    allowedTransitions(from as never, 'initiator')
      .filter((t) => !['T00', 'T19'].includes(t.id) && t.to !== 'in_review')
      .map(
        (t) =>
          `${t.to === 'same' ? from : t.to}:${t.proposedBy.includes('initiator') ? 'propose' : 'direct'}`,
      )
      .sort();

  it.each([
    'draft',
    'in_review',
    'needs_revision',
    'active',
    'paused',
    'stuck',
    'solved',
  ])('author in %s matches the guard', async (state) => {
    const id = await mine(state);
    const r = await http()
      .get(`/v1/drafts/${id}/actions`)
      .set(as(alice))
      .expect(200);
    expect(
      r.body.actions
        .map((a: { to: string; mode: string }) => `${a.to}:${a.mode}`)
        .sort(),
    ).toEqual(expected(state));
    expect(r.body.state).toBe(state);
  });

  it('empty for guests and other members on a public problem; 404 on a private one', async () => {
    const pub = await mine('active');
    const priv = await mine('draft');
    for (const h of [{}, as(bob)]) {
      const r = await http()
        .get(`/v1/drafts/${pub}/actions`)
        .set(h)
        .expect(200);
      expect(r.body.actions).toEqual([]);
      await http().get(`/v1/drafts/${priv}/actions`).set(h).expect(404);
    }
    await http().get('/v1/drafts/nope/actions').expect(404);
  });

  it('pause lists its required fields', async () => {
    const id = await mine('active');
    const r = await http()
      .get(`/v1/drafts/${id}/actions`)
      .set(as(alice))
      .expect(200);
    const p = r.body.actions.find((a: { to: string }) => a.to === 'paused');
    expect(p.requires).toEqual(['reasonCode', 'resumeCondition', 'reviewDate']);
  });
});
