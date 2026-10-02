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
const mk = async (acct: string, body: object = { title: 'Broken light' }) => {
  const r = await http()
    .post('/v1/drafts')
    .set(as(acct))
    .send(body)
    .expect(201);
  fx.problems.push(r.body.id);
  return r.body as { id: string; version: number; state: string };
};
const row = async (id: string) =>
  (await db.select().from(s.problem).where(eq(s.problem.id, id)))[0]!;
const events = (id: string) =>
  db.select().from(s.problemEvent).where(eq(s.problemEvent.problemId, id));

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

describe('drafts', () => {
  it('needs a session', async () => {
    await http().post('/v1/drafts').send({}).expect(401);
    await http().get('/v1/me/problems').expect(401);
  });

  it('create, patch and list: draft has no deletion date; T00 writes an event', async () => {
    const d = await mk(alice, { title: 'Broken light', coarseArea: 'Ward 3' });
    expect(d.state).toBe('draft');
    const r = await row(d.id);
    expect(r.initiatorId).toBe(alice);
    expect((await events(d.id)).map((e) => e.type)).toEqual(['draft_created']);
    const p = await http()
      .patch(`/v1/drafts/${d.id}`)
      .set(as(alice))
      .send({ condition: 'Dark at night', expectedVersion: 1 })
      .expect(200);
    expect(p.body.version).toBe(2);
    const ev = await events(d.id);
    expect(JSON.stringify(ev)).not.toContain('Dark at night');
    const l = await http().get('/v1/me/problems').set(as(alice)).expect(200);
    const item = l.body.items.find((i: { id: string }) => i.id === d.id);
    expect(item).toMatchObject({
      state: 'draft',
      label: 'Draft',
      title: 'Broken light',
      deleteAfter: null,
      appealableUntil: null,
      canEdit: true,
      canWithdraw: false,
    });
    expect(JSON.stringify(l.body)).not.toMatch(/email|initiator|owner/i);
  });

  it('others get 404 and never see it in their list', async () => {
    const d = await mk(alice);
    await http()
      .patch(`/v1/drafts/${d.id}`)
      .set(as(bob))
      .send({ title: 'x', expectedVersion: 1 })
      .expect(404);
    await http().delete(`/v1/drafts/${d.id}`).set(as(bob)).expect(404);
    await http().get(`/v1/problems/${d.id}`).set(as(bob)).expect(404);
    const l = await http().get('/v1/me/problems').set(as(bob)).expect(200);
    expect(l.body.items.some((i: { id: string }) => i.id === d.id)).toBe(false);
    await http().get(`/v1/problems/${d.id}`).set(as(alice)).expect(200);
  });

  it('GET /v1/drafts/:id returns version and content to the author only; lists carry version', async () => {
    const d = await mk(alice);
    const g = await http().get(`/v1/drafts/${d.id}`).set(as(alice)).expect(200);
    expect(g.body).toMatchObject({
      id: d.id,
      version: d.version,
      content: null,
    });
    await http().get(`/v1/drafts/${d.id}`).set(as(bob)).expect(404);
    await http().get(`/v1/drafts/${d.id}`).expect(401);
    const l = await http().get('/v1/me/problems').set(as(alice)).expect(200);
    expect(
      l.body.items.find((i: { id: string }) => i.id === d.id).version,
    ).toBe(d.version);
    await http().delete(`/v1/drafts/${d.id}`).set(as(alice)).expect(204);
    await http().get(`/v1/drafts/${d.id}`).set(as(alice)).expect(404);
  });

  it('limits give fieldErrors; unknown fields rejected; version mismatch conflicts', async () => {
    const d = await mk(alice);
    const r = await http()
      .patch(`/v1/drafts/${d.id}`)
      .set(as(alice))
      .send({ title: 'x'.repeat(121), expectedVersion: 1 })
      .expect(400);
    expect(r.body.error.fieldErrors.title).toBeTruthy();
    await http()
      .post('/v1/drafts')
      .set(as(alice))
      .send({ initiatorId: bob })
      .expect(400);
    await http()
      .patch(`/v1/drafts/${d.id}`)
      .set(as(alice))
      .send({ title: 'ok', expectedVersion: 5 })
      .expect(409);
  });

  it('edit is refused in held, rejected and public states; allowed in in_review', async () => {
    for (const st of ['held', 'rejected', 'active', 'solved']) {
      const id = await fx.problem(st, { initiatorId: alice });
      const r = await http()
        .patch(`/v1/drafts/${id}`)
        .set(as(alice))
        .send({ title: 'x', expectedVersion: 1 })
        .expect(409);
      expect(r.body.error.code).toBe('invalid_transition');
    }
    const id = await fx.problem('in_review', { initiatorId: alice });
    await http()
      .patch(`/v1/drafts/${id}`)
      .set(as(alice))
      .send({ title: 'y', expectedVersion: 1 })
      .expect(200);
    const l = await http().get('/v1/me/problems').set(as(alice)).expect(200);
    expect(l.body.items.find((i: { id: string }) => i.id === id)).toMatchObject(
      { canWithdraw: true, canEdit: true },
    );
  });

  it('delete (T19) scrubs content, hides the row, keeps the insert-only event log', async () => {
    const d = await mk(alice, {
      title: 'Secret name here',
      condition: 'details',
    });
    await http().delete(`/v1/drafts/${d.id}`).set(as(alice)).expect(204);
    const r = await row(d.id);
    expect(r.title).toBeNull();
    expect(r.condition).toBeNull();
    expect(r.deletedAt).not.toBeNull();
    expect((await events(d.id)).map((e) => e.type)).toEqual([
      'draft_created',
      'draft_deleted',
    ]);
    await http().get(`/v1/problems/${d.id}`).set(as(alice)).expect(404);
    await http().get(`/v1/problems/${d.id}/events`).set(as(alice)).expect(404);
    await http()
      .patch(`/v1/drafts/${d.id}`)
      .set(as(alice))
      .send({ title: 'x', expectedVersion: 2 })
      .expect(404);
    const l = await http().get('/v1/me/problems').set(as(alice)).expect(200);
    expect(l.body.items.some((i: { id: string }) => i.id === d.id)).toBe(false);
  });

  it('only a draft can be discarded', async () => {
    const id = await fx.problem('in_review', { initiatorId: alice });
    const r = await http()
      .delete(`/v1/drafts/${id}`)
      .set(as(alice))
      .expect(409);
    expect(r.body.error.code).toBe('invalid_transition');
  });

  it('lists with a cursor, newest first, and shows purge_after as deleteAfter', async () => {
    const carol = await signedIn();
    const when = new Date('2031-01-01T00:00:00Z');
    const a = await fx.problem('rejected', {
      initiatorId: carol,
      purgeAfter: when,
    });
    await fx.problem('draft', { initiatorId: carol });
    const p1 = await http()
      .get('/v1/me/problems?limit=1')
      .set(as(carol))
      .expect(200);
    expect(p1.body.items).toHaveLength(1);
    const p2 = await http()
      .get(`/v1/me/problems?limit=1&cursor=${p1.body.nextCursor}`)
      .set(as(carol))
      .expect(200);
    expect(p2.body.items[0]).toMatchObject({
      id: a,
      deleteAfter: when.toISOString(),
    });
  });

  it('rate limits creation at 20 per day', async () => {
    const dave = await signedIn();
    for (let i = 0; i < 20; i++) await mk(dave);
    await http().post('/v1/drafts').set(as(dave)).send({}).expect(429);
  });
});
