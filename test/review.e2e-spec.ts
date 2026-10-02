import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, newToken } from '../src/accounts/infra/crypto.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { config } from '../src/config.js';
import * as s from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { ReviewService } from '../src/review/app/review.service.js';
import { ReviewFactsImpl } from '../src/review/app/review-core.js';
import { FIXTURE_V1_DIR, ratifiedV1 } from './policy/helpers.js';
import { ProblemFixtures } from './support/problems.js';

const EX = join(FIXTURE_V1_DIR, 'base@1.0.0/content-schemas/problem/examples');
const example = (n: string): Record<string, any> =>
  JSON.parse(readFileSync(join(EX, `${n}.json`), 'utf8'));
const T01 = {
  title: 't',
  structuralStatement: 's',
  facts: ['f'],
  affectedScope: 'a',
  coarseArea: 'c',
  sources: ['u'],
  finalAcceptanceCriteria: ['c'],
  stagePlan: {},
  noIdentifiersConfirmed: true,
  schemaVersionPin: 'v1',
};
const REC = 'Add a second criterion that says how many poles must be checked.';
const WHY = 'Without a count, nobody can tell when the survey is finished.';

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
let alice: string; // poster
let v1: string;
let v2: string;
let v3: string;
let bob: string; // not a volunteer
const tokens: Record<string, string> = {};
const saved = { dir: config.policyPacksDir, active: config.policyActive };
const http = () => request(app.getHttpServer());
const as = (a: string) => ({ Authorization: `Bearer ${tokens[a]}` });
const row = async (id: string) =>
  (await db.select().from(s.problem).where(eq(s.problem.id, id)))[0]!;

async function signedIn(): Promise<string> {
  const id = await fx.account();
  tokens[id] = newToken();
  await db.insert(s.session).values({
    id: newId(),
    accountId: id,
    tokenHash: hashToken(tokens[id]),
    expiresAt: new Date(Date.now() + 3_600_000),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000),
    clientKind: 'native',
  });
  return id;
}
/** A problem in review through the real T01, with the parallel stage plan. */
async function inReview(): Promise<string> {
  const r = await http()
    .post('/v1/drafts')
    .set(as(alice))
    .send({ content: example('valid-with-parallel-stage-plan') })
    .expect(201);
  const id = r.body.id as string;
  fx.problems.push(id);
  await db
    .update(s.problem)
    .set({ initiatorId: alice })
    .where(eq(s.problem.id, id));
  await http()
    .post(`/v1/drafts/${id}/transitions`)
    .set(as(alice))
    .send({ to: 'in_review', fields: T01 })
    .expect(200);
  return id;
}
const optIn = (a: string) => http().post('/v1/me/review-opt-in').set(as(a));
const declare = (a: string, id: string) =>
  http().post(`/v1/review/${id}/session`).set(as(a)).send({ noConflict: true });
const recommend = (a: string, id: string, body: object) =>
  http().post(`/v1/review/${id}/recommendations`).set(as(a)).send(body);
const finish = (a: string, id: string, outcome: string) =>
  http().post(`/v1/review/${id}/finish`).set(as(a)).send({ outcome });
const status = (id: string) =>
  http().get(`/v1/me/problems/${id}/review-status`).set(as(alice));

beforeAll(async () => {
  const v = ratifiedV1();
  config.policyPacksDir = v.dir;
  config.policyActive = {
    default: {
      name: 'fiktiva-city',
      version: '1.0.0',
      hash: v.hash['fiktiva-city'],
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
  [alice, v1, v2, v3, bob] = [
    await signedIn(),
    await signedIn(),
    await signedIn(),
    await signedIn(),
    await signedIn(),
  ];
});
afterAll(async () => {
  await app.close();
  config.policyPacksDir = saved.dir;
  config.policyActive = saved.active;
  const all = fx.problems;
  const st = (
    await db
      .select({ id: s.stage.id })
      .from(s.stage)
      .where(inArray(s.stage.problemId, all))
  ).map((r) => r.id);
  await db
    .delete(s.reviewRecommendation)
    .where(inArray(s.reviewRecommendation.problemId, all));
  await db
    .delete(s.reviewSession)
    .where(inArray(s.reviewSession.problemId, all));
  if (st.length) {
    await db.delete(s.stageEvent).where(inArray(s.stageEvent.stageId, st));
    await db
      .delete(s.acceptanceCriterion)
      .where(inArray(s.acceptanceCriterion.stageId, st));
    await db.delete(s.stageEdge).where(inArray(s.stageEdge.stageId, st));
  }
  await db
    .delete(s.acceptanceCriterion)
    .where(inArray(s.acceptanceCriterion.problemId, all));
  if (st.length) await db.delete(s.stage).where(inArray(s.stage.id, st));
  await db.delete(s.sourceRef).where(inArray(s.sourceRef.problemId, all));
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

describe('review: access, masked view, recommendations, poster answers', () => {
  let p: string;
  let rec1: string;
  let rec2: string;

  it('T01 enters the queue and keeps a text snapshot; opt-in is required and takes effect at once', async () => {
    p = await inReview();
    const snaps = await db
      .select()
      .from(s.problemVersion)
      .where(eq(s.problemVersion.problemId, p));
    expect(snaps).toHaveLength(1);
    await http().get('/v1/review/queue').set(as(bob)).expect(403);
    await http().get('/v1/review/queue').expect(401);
    await optIn(v1).expect(200);
    await optIn(v2).expect(200);
    await optIn(v3).expect(200);
    await optIn(alice).expect(200);
    const q = await http().get('/v1/review/queue').set(as(v1)).expect(200);
    const mine = q.body.items.find((i: any) => i.problemId === p);
    expect(mine).toBeTruthy();
    expect(Object.keys(mine).sort()).toEqual([
      'coarseArea',
      'mine',
      'problemId',
      'sourceCount',
      'stageCount',
      'title',
    ]);
    // The poster's own problem is not in her queue.
    const own = await http().get('/v1/review/queue').set(as(alice)).expect(200);
    expect(own.body.items.some((i: any) => i.problemId === p)).toBe(false);
  });

  it('a member never reviews their own problem, and must declare no conflict first', async () => {
    await declare(alice, p).expect(403);
    await http().get(`/v1/review/${p}`).set(as(v1)).expect(403);
    await recommend(v1, p, {
      path: 'scope',
      recommendation: REC,
      reason: WHY,
    }).expect(403);
    await http()
      .post(`/v1/review/${p}/session`)
      .set(as(v1))
      .send({ noConflict: false })
      .expect(400);
    await declare(bob, p).expect(403);
    await declare(v1, p).expect(200);
    await declare(v1, p).expect(200); // idempotent
  });

  it('the masked view has an exact key set and no personal data, handle or account id', async () => {
    await db
      .update(s.problem)
      .set({ condition: 'Call Jo at jo.private@example.org about the lights.' })
      .where(eq(s.problem.id, p));
    const r = await http().get(`/v1/review/${p}`).set(as(v1)).expect(200);
    expect(Object.keys(r.body).sort()).toEqual([
      'content',
      'fields',
      'problemId',
      'redactionCount',
      'version',
    ]);
    expect(Object.keys(r.body.fields).sort()).toEqual([
      'affected',
      'coarseArea',
      'condition',
      'desiredOutcome',
      'observed',
      'title',
      'uncertain',
    ]);
    expect(Object.keys(r.body.content)).toEqual(
      expect.arrayContaining([
        'sources',
        'final_acceptance_criteria',
        'stage_plan',
      ]),
    );
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('jo.private@example.org');
    expect(r.body.redactionCount).toBeGreaterThan(0);
    const [a] = await db
      .select()
      .from(s.account)
      .where(eq(s.account.id, alice));
    for (const secret of [alice, a!.handle, 'initiator'])
      expect(text).not.toContain(secret);
  });

  it('fails closed when masking fails: nothing is shown', async () => {
    const svc = app.get(ReviewService) as any;
    const real = svc.masker;
    svc.masker = {
      mask: () => {
        throw new Error('boom');
      },
    };
    try {
      const r = await http().get(`/v1/review/${p}`).set(as(v1)).expect(503);
      expect(JSON.stringify(r.body)).not.toContain('Street lighting');
    } finally {
      svc.masker = real;
    }
  });

  it('validates the recommendation against the content schema and the problem real paths; masks personal data', async () => {
    await recommend(v1, p, {
      path: 'stage_plan.no_such.criteria',
      recommendation: REC,
      reason: WHY,
    }).expect(400);
    await recommend(v1, p, {
      path: 'somewhere in the middle',
      recommendation: REC,
      reason: WHY,
    }).expect(400);
    const short = await recommend(v1, p, {
      path: 'scope',
      recommendation: 'Needs work.',
      reason: WHY,
    }).expect(400);
    expect(short.body.error.code).toBe('schema_invalid');
    const a = await recommend(v1, p, {
      path: 'stage_plan.map_outages.criteria',
      recommendation: `${REC} Ask jo.private@example.org for the pole list.`,
      reason: WHY,
    }).expect(201);
    rec1 = a.body.id;
    const [stored] = await db
      .select()
      .from(s.reviewRecommendation)
      .where(eq(s.reviewRecommendation.id, rec1));
    expect(stored!.recommendation).not.toContain('jo.private@example.org');
    expect(stored!.status).toBe('open');
    const b = await recommend(v1, p, {
      path: 'scope',
      recommendation: REC,
      reason: WHY,
    }).expect(201);
    rec2 = b.body.id;
  });

  it('finishing must match the recommendations; a finished review takes no more; aggregates show only after finishing', async () => {
    await finish(v1, p, 'no_changes').expect(400);
    const before = await http()
      .get(`/v1/review/${p}/recommendations`)
      .set(as(v1))
      .expect(200);
    expect(before.body.aggregate).toBeNull();
    await finish(v1, p, 'recommendations').expect(200);
    await finish(v1, p, 'recommendations').expect(409);
    await recommend(v1, p, {
      path: 'scope',
      recommendation: REC,
      reason: WHY,
    }).expect(409);
    const after = await http()
      .get(`/v1/review/${p}/recommendations`)
      .set(as(v1))
      .expect(200);
    expect(after.body.aggregate).toEqual({
      finishedReviews: 1,
      open: 2,
      accepted: 0,
      declined: 0,
    });
    // A volunteer sees only their own.
    await declare(v2, p).expect(200);
    const other = await http()
      .get(`/v1/review/${p}/recommendations`)
      .set(as(v2))
      .expect(200);
    expect(other.body.recommendations).toEqual([]);
  });

  it('the poster sees numbered volunteers only; decline needs a reason; accept can apply a value', async () => {
    const l = await http()
      .get(`/v1/me/problems/${p}/recommendations`)
      .set(as(alice))
      .expect(200);
    expect(l.body.items).toHaveLength(2);
    expect(l.body.items[0].volunteer).toBe('Volunteer 1');
    const text = JSON.stringify(l.body);
    expect(text).not.toContain(v1);
    await http()
      .get(`/v1/me/problems/${p}/recommendations`)
      .set(as(bob))
      .expect(404);
    await http()
      .post(`/v1/recommendations/${rec1}/resolve`)
      .set(as(bob))
      .send({ decision: 'decline', reason: 'No, thanks.' })
      .expect(404);
    await http()
      .post(`/v1/recommendations/${rec1}/resolve`)
      .set(as(alice))
      .send({ decision: 'decline' })
      .expect(400);
    await http()
      .post(`/v1/recommendations/${rec1}/resolve`)
      .set(as(alice))
      .send({ decision: 'decline', reason: 'x' })
      .expect(400);
    const before = await row(p);
    const d = await http()
      .post(`/v1/recommendations/${rec1}/resolve`)
      .set(as(alice))
      .send({
        decision: 'decline',
        reason: 'The stage already counts the poles.',
      })
      .expect(200);
    expect(d.body.status).toBe('declined');
    expect((await row(p)).version).toBe(before.version); // decline keeps the draft
    await http()
      .post(`/v1/recommendations/${rec1}/resolve`)
      .set(as(alice))
      .send({ decision: 'accept', reason: 'Changed my mind.' })
      .expect(409);
    const newScope =
      'Street lighting in the north district since last March, not other utilities or roads.';
    const a = await http()
      .post(`/v1/recommendations/${rec2}/resolve`)
      .set(as(alice))
      .send({
        decision: 'accept',
        reason: 'Widened the scope as asked.',
        value: newScope,
        expectedVersion: before.version,
      })
      .expect(200);
    expect(a.body.status).toBe('accepted');
    const after = await row(p);
    expect((after.content as any).scope).toBe(newScope);
    expect(after.version).toBe(before.version + 1);
    // The reviewer sees the poster's answer.
    const mine = await http()
      .get(`/v1/review/${p}/recommendations`)
      .set(as(v1))
      .expect(200);
    expect(mine.body.recommendations.map((x: any) => x.status).sort()).toEqual([
      'accepted',
      'declined',
    ]);
    expect(
      mine.body.recommendations.every((x: any) => x.resolutionReason),
    ).toBe(true);
  });

  it('an edit in review marks the recommendation changed since; T03 reopens a resolved one on a changed path', async () => {
    const hooks = (await import('../src/review/app/review-core.js'))
      .ReviewHooksImpl;
    const h = app.get(hooks);
    await db.transaction(async (tx) => {
      await h.markChanged(tx, p, 99, ['stage_plan.map_outages.criteria']);
      await h.reopen(tx, p, ['stage_plan.map_outages.criteria', 'sources']);
    });
    const [r] = await db
      .select()
      .from(s.reviewRecommendation)
      .where(eq(s.reviewRecommendation.id, rec1));
    expect(r).toMatchObject({
      status: 'open',
      resolutionReason: null,
      changedAtVersion: 99,
    });
    const [r2] = await db
      .select()
      .from(s.reviewRecommendation)
      .where(eq(s.reviewRecommendation.id, rec2));
    expect(r2!.status).toBe('accepted'); // path not changed: stays resolved
  });
});

describe('review: quorum and publication', () => {
  it('zero finished reviews keeps the problem in review and asks for reviewers; T04 facts fail closed', async () => {
    const p = await inReview();
    const st = await status(p).expect(200);
    expect(st.body).toMatchObject({
      reviewCount: 0,
      needsReviewers: true,
      quorumMet: false,
      canRequestPublication: false,
    });
    await http()
      .post(`/v1/me/problems/${p}/request-publication`)
      .set(as(alice))
      .expect(403);
    const f = await db.transaction((tx) => app.get(ReviewFactsImpl).get(tx, p));
    expect(f).toEqual({
      atLeastOneCompletedReview: false,
      reviewQuorumMetOrPosterOverride: false,
    });
    await status(p).set(as(bob)).expect(404);
  });

  it('three finished reviews make the quorum unless a recommendation is stale; opting out keeps finished reviews', async () => {
    const p = await inReview();
    for (const v of [v1, v2, v3]) {
      await declare(v, p).expect(200);
    }
    await recommend(v1, p, {
      path: 'scope',
      recommendation: REC,
      reason: WHY,
    }).expect(201);
    await finish(v1, p, 'recommendations').expect(200);
    await finish(v2, p, 'no_changes').expect(200);
    let st = await status(p).expect(200);
    expect(st.body).toMatchObject({
      reviewCount: 2,
      quorumMet: false,
      canRequestPublication: false,
      needsReviewers: false,
      openRecommendations: 1,
    });
    await finish(v3, p, 'no_changes').expect(200);
    st = await status(p).expect(200);
    expect(st.body).toMatchObject({
      reviewCount: 3,
      quorumMet: true,
      canRequestPublication: true,
    });
    // The one open recommendation goes stale after 7 days.
    await db
      .update(s.reviewRecommendation)
      .set({ openedAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(s.reviewRecommendation.problemId, p));
    st = await status(p).expect(200);
    expect(st.body).toMatchObject({
      quorumMet: false,
      canRequestPublication: false,
    });
    await db
      .update(s.reviewRecommendation)
      .set({ openedAt: new Date() })
      .where(eq(s.reviewRecommendation.problemId, p));
    // Opt-out is immediate and keeps the finished review.
    await http().delete('/v1/me/review-opt-in').set(as(v3)).expect(200);
    await http().get('/v1/review/queue').set(as(v3)).expect(403);
    expect((await status(p).expect(200)).body.reviewCount).toBe(3);
    // Ask for publication: recorded once, and the T04 facts turn true.
    await http()
      .post(`/v1/me/problems/${p}/request-publication`)
      .set(as(alice))
      .expect(200);
    await http()
      .post(`/v1/me/problems/${p}/request-publication`)
      .set(as(alice))
      .expect(200);
    const ev = await db
      .select()
      .from(s.problemEvent)
      .where(
        and(
          eq(s.problemEvent.problemId, p),
          eq(s.problemEvent.type, 'publication_requested'),
        ),
      );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toEqual({});
    const f = await db.transaction((tx) => app.get(ReviewFactsImpl).get(tx, p));
    expect(f).toEqual({
      atLeastOneCompletedReview: true,
      reviewQuorumMetOrPosterOverride: true,
    });
    await optIn(v3).expect(200);
  });

  it('one finished review plus 14 days lets the poster send it anyway; day 13 does not', async () => {
    const p = await inReview();
    await declare(v1, p).expect(200);
    await finish(v1, p, 'no_changes').expect(200);
    const back = (days: number) =>
      db
        .update(s.problem)
        .set({
          reviewRequestedAt: new Date(Date.now() - days * 86_400_000 - 60_000),
        })
        .where(eq(s.problem.id, p));
    await back(13);
    expect((await status(p).expect(200)).body).toMatchObject({
      dayCount: 13,
      canRequestPublication: false,
    });
    await http()
      .post(`/v1/me/problems/${p}/request-publication`)
      .set(as(alice))
      .expect(403);
    await back(14);
    expect((await status(p).expect(200)).body).toMatchObject({
      dayCount: 14,
      quorumMet: false,
      canRequestPublication: true,
    });
    await http()
      .post(`/v1/me/problems/${p}/request-publication`)
      .set(as(alice))
      .expect(200);
    const f = await db.transaction((tx) => app.get(ReviewFactsImpl).get(tx, p));
    expect(f.reviewQuorumMetOrPosterOverride).toBe(true);
  });

  it('review routes are private: no session, no data; /v1/problems never carries review fields', async () => {
    const p = await inReview();
    for (const path of [
      '/v1/review/queue',
      `/v1/review/${p}`,
      `/v1/review/${p}/recommendations`,
      `/v1/me/problems/${p}/recommendations`,
      `/v1/me/problems/${p}/review-status`,
      '/v1/me/review-opt-in',
    ])
      await http().get(path).expect(401);
    const pub = await http().get(`/v1/problems/${p}`);
    expect(pub.status).toBe(404);
    const list = await http().get('/v1/problems').expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/recommendation|review_/);
  });
});
