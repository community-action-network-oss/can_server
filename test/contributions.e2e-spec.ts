import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, newToken } from '../src/accounts/infra/crypto.js';
import { AppModule } from '../src/app.module.js';
import { buildDocument, configureApp } from '../src/app.setup.js';
import { config } from '../src/config.js';
import * as s from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { ratifiedV1 } from './policy/helpers.js';
import { ProblemFixtures } from './support/problems.js';

const saved = { dir: config.policyPacksDir, active: config.policyActive };
const EX = join(
  process.cwd(),
  'test/fixtures/policy-v1/base@1.0.0/content-schemas',
);
/** A body the pinned schema accepts: the committed valid example of that type. */
const valid = (type: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      join(EX, `contribution.${type}`, 'examples/valid-1.json'),
      'utf8',
    ),
  );

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
const stages: string[] = [];

const auth = async (a: string) => {
  const token = newToken();
  await db.insert(s.session).values({
    id: newId(),
    accountId: a,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000),
    clientKind: 'native',
  });
  return { Authorization: `Bearer ${token}` };
};
const person = async () => {
  const id = await fx.account();
  return { id, h: await auth(id) };
};
const live = (state = 'active') =>
  fx.problem(state, { publishedAt: new Date() });
const stageOf = async (problemId: string, state: string) => {
  const id = newId();
  await db.insert(s.stage).values({
    id,
    problemId,
    name: `st-${id.slice(-8)}`,
    goal: 'Goal',
    state,
    decisionMethod: 'poster_after_input',
    ordinal: 1,
    originNodeId: config.nodeId,
    protocolVersion: '1',
  });
  stages.push(id);
  return id;
};
const post = (
  p: { h: object },
  problemId: string,
  type: string,
  extra: Record<string, unknown> = {},
  body = valid(type),
) =>
  request(app.getHttpServer())
    .post(`/v1/contributions/by-problem/${problemId}`)
    .set(p.h)
    .send({ type, body, ...extra });
const list = (problemId: string, h?: object, qs = '') => {
  const r = request(app.getHttpServer()).get(
    `/v1/contributions/by-problem/${problemId}${qs}`,
  );
  return h ? r.set(h) : r;
};
const rows = (problemId: string) =>
  db
    .select()
    .from(s.contribution)
    .where(eq(s.contribution.problemId, problemId));
/** Rows that already used up the cap, `ago` ms old each. */
const seed = (accountId: string, problemId: string, agos: number[]) =>
  db.insert(s.contribution).values(
    agos.map((ago) => ({
      id: newId(),
      problemId,
      authorId: accountId,
      type: 'observation',
      body: {},
      createdAt: new Date(Date.now() - ago),
      originNodeId: config.nodeId,
      protocolVersion: '1',
    })),
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
  const cs = fx.problems.length
    ? await db
        .select({ id: s.contribution.id })
        .from(s.contribution)
        .where(inArray(s.contribution.problemId, fx.problems))
    : [];
  const ids = cs.map((c) => c.id);
  if (ids.length) {
    await db
      .delete(s.evidenceRef)
      .where(inArray(s.evidenceRef.contributionId, ids));
    await db
      .delete(s.stageOption)
      .where(inArray(s.stageOption.contributionId, ids));
    await db.delete(s.auditEvent).where(inArray(s.auditEvent.subjectId, ids));
    await db.delete(s.contribution).where(inArray(s.contribution.id, ids));
  }
  if (stages.length)
    await db.delete(s.stage).where(inArray(s.stage.id, stages));
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

describe('POST /v1/contributions/by-problem/:id', () => {
  it('needs a session', async () => {
    const p = await live();
    await request(app.getHttpServer())
      .post(`/v1/contributions/by-problem/${p}`)
      .send({ type: 'observation', body: {} })
      .expect(401);
  });

  it('happy paths: three types, pending and visible only to the author', async () => {
    const p = await live();
    const out: Record<string, unknown>[] = [];
    for (const type of ['observation', 'evidence', 'clarifying_question']) {
      const who = await person();
      const r = await post(who, p, type).expect(201);
      expect(r.body).toMatchObject({
        type,
        status: 'pending_review',
        stageId: null,
        forLaterStage: false,
      });
      expect(r.body.evidenceRefs[0]).toMatchObject({
        url: 'https://example.org/lighting-register',
        category: 'other',
      });
      out.push(r.body);
      expect(
        (await list(p, who.h).expect(200)).body.items.map(
          (i: { id: string }) => i.id,
        ),
      ).toEqual([r.body.id]);
    }
    expect((await list(p).expect(200)).body.items).toEqual([]);
    const other = await person();
    expect((await list(p, other.h).expect(200)).body.items).toEqual([]);
    // published by a run: everyone sees it, in creation order, with no counts
    await db
      .update(s.contribution)
      .set({ status: 'accepted', reviewedAt: new Date() })
      .where(eq(s.contribution.problemId, p));
    const pub = (await list(p).expect(200)).body;
    expect(pub.criteria).toEqual({
      order: 'created_at_asc',
      usesEngagementSignals: false,
    });
    expect(pub.items.map((i: { id: string }) => i.id)).toEqual(
      out.map((o) => o.id),
    );
    for (const i of pub.items)
      expect(Object.keys(i).sort()).toEqual([
        'answersContributionId',
        'authorHandle',
        'body',
        'createdAt',
        'evidenceRefs',
        'forLaterStage',
        'id',
        'stageId',
        'status',
        'tombstonedAt',
        'type',
      ]);
  });

  it('writes a moderation event with ids only', async () => {
    const p = await live();
    const who = await person();
    const id = (await post(who, p, 'observation').expect(201)).body.id;
    const [e] = await db
      .select()
      .from(s.problemEvent)
      .where(eq(s.problemEvent.problemId, p));
    expect(e).toMatchObject({
      type: 'contribution.submitted',
      payload: { contributionId: id, type: 'observation' },
    });
  });

  it('refuses a type the state does not allow, writing no row (progress_update on a planned stage)', async () => {
    const p = await live();
    const st = await stageOf(p, 'planned');
    const who = await person();
    const r = await post(who, p, 'progress_update', { stageId: st }).expect(
      409,
    );
    expect(r.body.error.code).toBe('not_allowed_in_state');
    expect(await rows(p)).toHaveLength(0);
    await post(who, p, 'moderation_feedback').expect(400);
    const draft = await fx.problem('draft', { initiatorId: who.id });
    expect(
      (await post(who, draft, 'observation').expect(409)).body.error.code,
    ).toBe('not_allowed_in_state');
    await post(who, newId(), 'observation').expect(404);
    const elsewhere = await live();
    expect(
      (await post(who, elsewhere, 'observation', { stageId: st }).expect(400))
        .body.error.fieldErrors.stageId,
    ).toBeTruthy();
  });

  it('keeps a contribution made ahead to a planned stage and lists it for that stage', async () => {
    const p = await live();
    const st = await stageOf(p, 'planned');
    const who = await person();
    const r = await post(who, p, 'observation', { stageId: st }).expect(201);
    expect(r.body).toMatchObject({ stageId: st, forLaterStage: true });
    expect(
      (await list(p, who.h, `?stageId=${st}`).expect(200)).body.items,
    ).toHaveLength(1);
    expect(
      (await list(p, who.h, '?problemLevel=true').expect(200)).body.items,
    ).toHaveLength(0);
  });

  it('a proposed_solution to a stage creates a hidden stage option', async () => {
    const p = await live();
    const st = await stageOf(p, 'active');
    const who = await person();
    const r = await post(who, p, 'proposed_solution', { stageId: st }).expect(
      201,
    );
    const [o] = await db
      .select()
      .from(s.stageOption)
      .where(eq(s.stageOption.contributionId, r.body.id));
    expect(o).toMatchObject({
      stageId: st,
      status: 'pending',
      authorId: who.id,
      forLaterStage: false,
    });
  });

  it('reports schema_invalid with a pointer for a missing required answer', async () => {
    const p = await live();
    const who = await person();
    const body = valid('observation');
    delete body.claim;
    const r = await post(who, p, 'observation', {}, body).expect(400);
    expect(r.body.error.code).toBe('schema_invalid');
    expect(Object.keys(r.body.error.fieldErrors).join()).toContain('claim');
    expect(await rows(p)).toHaveLength(0);
  });

  it('rejects hard flags with fieldErrors and an evidence type without a link', async () => {
    const p = await live();
    const who = await person();
    const body = {
      ...valid('observation'),
      claim:
        'Write to me at jane.doe@example.com about the lights on the ring road.',
    };
    const r = await post(who, p, 'observation', {}, body).expect(400);
    expect(r.body.error.code).toBe('validation_failed');
    expect(r.body.error.fieldErrors['/body/claim']).toBeTruthy();
    const noLink = { ...valid('evidence'), evidence_refs: [] };
    await post(who, p, 'evidence', {}, noLink).expect(400);
    expect(await rows(p)).toHaveLength(0);
  });

  it('checks the answers link', async () => {
    const p = await live();
    const who = await person();
    const q = newId();
    await db.insert(s.contribution).values({
      id: q,
      problemId: p,
      authorId: who.id,
      type: 'clarifying_question',
      body: {},
      status: 'accepted',
      createdAt: new Date(Date.now() - 48 * 3_600_000),
      originNodeId: config.nodeId,
      protocolVersion: '1',
    });
    const pending = newId();
    await db.insert(s.contribution).values({
      id: pending,
      problemId: p,
      authorId: who.id,
      type: 'clarifying_question',
      body: {},
      createdAt: new Date(Date.now() - 48 * 3_600_000),
      originNodeId: config.nodeId,
      protocolVersion: '1',
    });
    const a = await person();
    await post(a, p, 'factual_claim', {
      answersContributionId: pending,
    }).expect(400);
    await post(a, p, 'observation', { answersContributionId: q }).expect(400);
    const ok = await post(a, p, 'factual_claim', {
      answersContributionId: q,
    }).expect(201);
    expect(ok.body.answersContributionId).toBe(q);
  });
});

describe('cooldown and reply allowance (D-85)', () => {
  it('cooldown applies between replies, with retryAfterSeconds; progress_update is exempt', async () => {
    const p = await live();
    const who = await person();
    await post(who, p, 'observation').expect(201);
    const r = await post(who, p, 'observation').expect(429);
    expect(r.body.error.code).toBe('cooldown_active');
    expect(r.body.error.retryAfterSeconds).toBeGreaterThan(100);
    expect(r.body.error.retryAfterSeconds).toBeLessThanOrEqual(120);
    await post(who, p, 'progress_update').expect(201);
    expect(await rows(p)).toHaveLength(2);
  });

  it('the 5th reply in 24 hours is refused; withdrawn count, edits do not; other problems and people are unaffected', async () => {
    const p = await live();
    const who = await person();
    const ids: string[] = [];
    for (let n = 0; n < 4; n++)
      ids.push((await post(who, p, 'progress_update').expect(201)).body.id);
    const allowance = () =>
      request(app.getHttpServer())
        .get(`/v1/me/problems/${p}/reply-allowance`)
        .set(who.h);
    expect((await allowance().expect(200)).body).toMatchObject({
      limit: 4,
      remaining: 0,
    });
    const r = await post(who, p, 'progress_update').expect(429);
    expect(r.body.error).toMatchObject({
      code: 'reply_limit_reached',
      limit: 4,
      remaining: 0,
    });
    expect(r.body.error.resetsAt).toBe((await allowance()).body.resetsAt);
    // withdrawing frees nothing
    await request(app.getHttpServer())
      .patch(`/v1/contributions/${ids[0]}`)
      .set(who.h)
      .send({ withdraw: true })
      .expect(200);
    await post(who, p, 'progress_update').expect(429);
    // a refused reply wrote nothing
    expect(await rows(p)).toHaveLength(4);
    await post(who, await live(), 'progress_update').expect(201);
    await post(await person(), p, 'progress_update').expect(201);
  });

  it('edits are not replies', async () => {
    const p = await live();
    const who = await person();
    const id = (await post(who, p, 'observation').expect(201)).body.id;
    const body = {
      ...valid('observation'),
      claim: 'Several lights between the bridge and the market were dark.',
    };
    for (let n = 0; n < 5; n++)
      await request(app.getHttpServer())
        .patch(`/v1/contributions/${id}`)
        .set(who.h)
        .send({ body })
        .expect(200);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/v1/me/problems/${p}/reply-allowance`)
          .set(who.h)
      ).body.remaining,
    ).toBe(3);
  });

  it('the stricter of cooldown and allowance wins', async () => {
    const MIN = 60_000;
    // allowance frees in ~1h, cooldown ends in ~1m: allowance is stricter
    const p1 = await live();
    const a = await person();
    await seed(a.id, p1, [23 * 60 * MIN, 22 * 60 * MIN, 21 * 60 * MIN, 1_000]);
    expect((await post(a, p1, 'observation').expect(429)).body.error.code).toBe(
      'reply_limit_reached',
    );
    // allowance frees in ~10s, cooldown ends in ~2m: cooldown is stricter
    const p2 = await live();
    const b = await person();
    await seed(b.id, p2, [
      24 * 60 * MIN - 10_000,
      22 * 60 * MIN,
      21 * 60 * MIN,
      1_000,
    ]);
    const r = await post(b, p2, 'observation').expect(429);
    expect(r.body.error.code).toBe('cooldown_active');
  });
});

describe('PATCH /v1/contributions/:id', () => {
  it('withdraw tombstones: body gone, evidence gone, still listed as a dated placeholder once published', async () => {
    const p = await live();
    const who = await person();
    const id = (await post(who, p, 'observation').expect(201)).body.id;
    await db
      .update(s.contribution)
      .set({ status: 'accepted', reviewedAt: new Date() })
      .where(eq(s.contribution.id, id));
    await request(app.getHttpServer())
      .patch(`/v1/contributions/${id}`)
      .set((await person()).h)
      .send({ withdraw: true })
      .expect(404);
    const r = await request(app.getHttpServer())
      .patch(`/v1/contributions/${id}`)
      .set(who.h)
      .send({ withdraw: true })
      .expect(200);
    expect(r.body).toMatchObject({
      status: 'tombstoned',
      body: null,
      evidenceRefs: [],
    });
    expect(r.body.tombstonedAt).toBeTruthy();
    const pub = (await list(p).expect(200)).body.items;
    expect(pub).toHaveLength(1);
    expect(pub[0]).toMatchObject({ id, status: 'tombstoned', body: null });
  });

  it('a withdrawn reply that was never published stays private', async () => {
    const p = await live();
    const who = await person();
    const id = (await post(who, p, 'observation').expect(201)).body.id;
    await request(app.getHttpServer())
      .patch(`/v1/contributions/${id}`)
      .set(who.h)
      .send({ withdraw: true })
      .expect(200);
    expect((await list(p).expect(200)).body.items).toEqual([]);
  });

  it('edits only while awaiting review, and revalidates', async () => {
    const p = await live();
    const who = await person();
    const id = (await post(who, p, 'observation').expect(201)).body.id;
    const bad = valid('observation');
    delete bad.claim;
    await request(app.getHttpServer())
      .patch(`/v1/contributions/${id}`)
      .set(who.h)
      .send({ body: bad })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/v1/contributions/${id}`)
      .set(who.h)
      .send({})
      .expect(400);
    await db
      .update(s.contribution)
      .set({ status: 'accepted' })
      .where(eq(s.contribution.id, id));
    await request(app.getHttpServer())
      .patch(`/v1/contributions/${id}`)
      .set(who.h)
      .send({ body: valid('observation') })
      .expect(409);
    await request(app.getHttpServer())
      .patch(`/v1/contributions/${id}`)
      .send({ withdraw: true })
      .expect(401);
  });
});

describe('contract', () => {
  it('has no multipart route and keeps /v1/problems* at three GETs', async () => {
    const doc = JSON.stringify(buildDocument(app));
    expect(doc).not.toContain('multipart/form-data');
    const paths = JSON.parse(doc).paths as Record<
      string,
      Record<string, unknown>
    >;
    const ops = Object.entries(paths)
      .filter(([k]) => k.startsWith('/v1/problems'))
      .flatMap(([, v]) => Object.keys(v));
    expect(ops).toEqual(['get', 'get', 'get']);
  });
});
