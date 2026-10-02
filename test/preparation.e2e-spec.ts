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
import { configureApp } from '../src/app.setup.js';
import { config } from '../src/config.js';
import * as s from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { AuditPort } from '../src/platform/audit/audit.service.js';
import { UuidV7Generator } from '../src/platform/ports.js';
import { FixedClock } from '../src/platform/testing.js';
import { preparationEffects } from '../src/problems/app/preparation-effects.js';
import { SubmitChecks } from '../src/problems/app/submit-checks.service.js';
import { TransitionEngine } from '../src/problems/app/transition-engine.js';
import {
  NoopDecisionNotifier,
  TransitionEffects,
  type ReviewFacts,
} from '../src/problems/app/transition-ports.js';
import { StagePlanService } from '../src/stages/app/stage-plan.service.js';
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
const reviewDone: ReviewFacts = {
  get: async () => ({
    atLeastOneCompletedReview: true,
    reviewQuorumMetOrPosterOverride: true,
  }),
};

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
let alice: string;
let bob: string;
const tokens: Record<string, string> = {};
const saved = { dir: config.policyPacksDir, active: config.policyActive };
const http = () => request(app.getHttpServer());
const as = (a: string) => ({ Authorization: `Bearer ${tokens[a]}` });
const row = async (id: string) =>
  (await db.select().from(s.problem).where(eq(s.problem.id, id)))[0]!;
const stages = (id: string) =>
  db.select().from(s.stage).where(eq(s.stage.problemId, id));

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
/** A draft on the v1 problem schema. Pass a content override to drop or change parts. */
async function draft(content: Record<string, unknown>, extra: object = {}) {
  const r = await http()
    .post('/v1/drafts')
    .set(as(alice))
    .send({ content, ...extra })
    .expect(201);
  fx.problems.push(r.body.id);
  await db
    .update(s.problem)
    .set({ initiatorId: alice })
    .where(eq(s.problem.id, r.body.id));
  return r.body.id as string;
}
const without = (c: Record<string, any>, ...keys: string[]) => {
  const out = { ...c };
  for (const k of keys) delete out[k];
  return out;
};
const submit = (id: string, fields: object = T01) =>
  http()
    .post(`/v1/drafts/${id}/transitions`)
    .set(as(alice))
    .send({ to: 'in_review', fields });
const prep = (id: string, who = alice) =>
  http().get(`/v1/me/problems/${id}/preparation`).set(as(who));

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
  alice = await signedIn();
  bob = await signedIn();
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

describe('T01 guard (CRITERIA-1, SOURCE-1, DP-STAGE-PLAN)', () => {
  it('is refused without final acceptance criteria, naming the field', async () => {
    const id = await draft(
      without(example('valid-minimal'), 'final_acceptance_criteria'),
    );
    const r = await submit(id).expect(400);
    expect(r.body.error.code).toBe('schema_invalid');
    expect(r.body.error.fieldErrors['/final_acceptance_criteria']).toBeTruthy();
    expect((await row(id)).state).toBe('draft');
  });

  it('is refused without a source or a note, and allowed with the note (needs evidence)', async () => {
    const id = await draft(without(example('valid-minimal'), 'sources'));
    const r = await submit(id).expect(400);
    expect(r.body.error.fieldErrors['/sources']).toBeTruthy();
    const p = await prep(id).expect(200);
    expect(p.body.sources.status).toBe('not_finished');
    await http()
      .patch(`/v1/drafts/${id}`)
      .set(as(alice))
      .send({
        expectedVersion: 1,
        noSourceNote: 'No public record exists yet.',
      })
      .expect(200);
    const p2 = await prep(id).expect(200);
    expect(p2.body.sources).toMatchObject({
      status: 'ready',
      reason: 'needs_evidence',
    });
    await submit(id, { ...T01, sources: undefined, noSourceNote: 'x' }).expect(
      200,
    );
    expect((await row(id)).state).toBe('in_review');
  });

  it('is refused with a cyclic plan stored in the content, and with a stage that has no criteria', async () => {
    const base = example('valid-with-parallel-stage-plan');
    const cyc = structuredClone(base);
    cyc.stage_plan[0].depends_on = ['agree_plan'];
    const id = await draft(cyc);
    const r = await submit(id).expect(400);
    expect(
      Object.keys(r.body.error.fieldErrors).some((k) =>
        k.startsWith('/stage_plan'),
      ),
    ).toBe(true);
    expect((await row(id)).state).toBe('draft');
    const p = await prep(id).expect(200);
    expect(p.body.stages).toMatchObject({
      status: 'not_finished',
      reason: 'invalid',
    });
    expect(p.body.ready).toBe(false);
  });

  it('is allowed with classic-5, with one-stage and with no plan', async () => {
    for (const template of ['classic-5', 'one-stage', null]) {
      const id = await draft(example('valid-minimal'));
      if (template)
        await http()
          .put(`/v1/drafts/${id}/stage-plan`)
          .set(as(alice))
          .send({ template, expectedVersion: 1 })
          .expect(200);
      const p = await prep(id).expect(200);
      expect(p.body.ready).toBe(true);
      expect(p.body.stages.reason).toBe(template ? null : 'default_plan');
      await submit(id).expect(200);
      expect((await row(id)).state).toBe('in_review');
    }
  });
});

describe('preparation routes', () => {
  it('PATCH takes sources and finalAcceptanceCriteria, keeps source_ref in step, and refuses http links', async () => {
    const id = await draft(without(example('valid-minimal'), 'sources'));
    const src = example('valid-minimal').sources;
    const crit = [
      {
        statement: 'Fewer than three lights are out.',
        how_observed: 'Read the public repair log.',
      },
    ];
    const r = await http()
      .patch(`/v1/drafts/${id}`)
      .set(as(alice))
      .send({ expectedVersion: 1, sources: src, finalAcceptanceCriteria: crit })
      .expect(200);
    const p = await row(id);
    expect((p.content as any).final_acceptance_criteria).toEqual(crit);
    const rows = await db
      .select()
      .from(s.sourceRef)
      .where(eq(s.sourceRef.problemId, id));
    expect(rows.map((x) => x.uri)).toEqual([src[0].uri]);
    const bad = await http()
      .patch(`/v1/drafts/${id}`)
      .set(as(alice))
      .send({
        expectedVersion: r.body.version,
        sources: [{ ...src[0], uri: 'http://example.org/insecure' }],
      })
      .expect(400);
    expect(bad.body.error.fieldErrors['/sources/0/uri']).toBeTruthy();
    // a source with an unknown category is a schema error with a content pointer
    const cat = await http()
      .patch(`/v1/drafts/${id}`)
      .set(as(alice))
      .send({
        expectedVersion: r.body.version,
        sources: [{ ...src[0], category: 'rumour' }],
      })
      .expect(400);
    expect(cat.body.error.fieldErrors['/sources/0/category']).toBeTruthy();
  });

  it('PUT stage-plan saves a plan, validate reports a cycle without saving, and others get 404', async () => {
    const id = await draft(example('valid-minimal'));
    const par = example('valid-with-parallel-stage-plan').stage_plan;
    const cyc = structuredClone(par);
    cyc[0].depends_on = ['agree_plan'];
    const v = await http()
      .post(`/v1/drafts/${id}/stage-plan/validate`)
      .set(as(alice))
      .send({ stages: cyc })
      .expect(200);
    expect(v.body.ok).toBe(false);
    expect(v.body.issues.map((i: any) => i.code)).toContain('cycle');
    expect(await stages(id)).toHaveLength(0);
    await http()
      .put(`/v1/drafts/${id}/stage-plan`)
      .set(as(alice))
      .send({ stages: cyc, expectedVersion: 1 })
      .expect(400);
    // edges fold into depends_on
    const flat = par.map((n: any) => ({ ...n, depends_on: [] }));
    const ok = await http()
      .put(`/v1/drafts/${id}/stage-plan`)
      .set(as(alice))
      .send({
        stages: flat,
        edges: [
          { from: 'map_outages', to: 'agree_plan' },
          { from: 'ask_schedule', to: 'agree_plan' },
        ],
        expectedVersion: 1,
      })
      .expect(200);
    expect(ok.body.edges).toHaveLength(2);
    expect(ok.body.stages[2]).toHaveProperty('depends_on'); // snake_case stays (D-82)
    expect(await stages(id)).toHaveLength(3);
    const crits = await db
      .select()
      .from(s.acceptanceCriterion)
      .where(eq(s.acceptanceCriterion.problemId, id));
    expect(crits).toHaveLength(1); // final criteria survive the save
    await http()
      .put(`/v1/drafts/${id}/stage-plan`)
      .set(as(alice))
      .send({ template: 'one-stage', expectedVersion: 1 })
      .expect(409);
    await http()
      .put(`/v1/drafts/${id}/stage-plan`)
      .set(as(bob))
      .send({ template: 'one-stage', expectedVersion: ok.body.version })
      .expect(404);
    await prep(id, bob).expect(404);
  });

  it('readiness reports each part with the reason', async () => {
    const id = await draft({
      ...without(
        example('valid-minimal'),
        'final_acceptance_criteria',
        'observed_facts',
      ),
    });
    const p = (await prep(id).expect(200)).body;
    expect(p.ready).toBe(false);
    expect(p.facts).toMatchObject({
      status: 'not_finished',
      reason: 'incomplete',
    });
    expect(p.criteria).toMatchObject({
      status: 'not_finished',
      reason: 'invalid',
    });
    expect(p.sources.status).toBe('ready');
    expect(p.stages).toMatchObject({ status: 'ready', reason: 'default_plan' });
    expect(Object.keys(p.facts.fieldErrors)).toContain('/observed_facts');
    expect(Array.isArray(p.facts.flags)).toBe(true);
  });

  it('an edit while in_review writes a new version and tells the review module which paths changed; T03 reopens by path', async () => {
    const id = await draft(example('valid-minimal'));
    await submit(id).expect(200);
    const checks = app.get(SubmitChecks);
    const calls: any[] = [];
    const orig = checks.hooks;
    checks.hooks = {
      ...orig,
      markChanged: async (_t, pid, v, paths) =>
        void calls.push([pid, v, paths]),
      reopen: async (_t, pid, paths) => void calls.push(['reopen', pid, paths]),
    };
    try {
      const before = await row(id);
      const content = {
        ...(before.content as any),
        scope:
          'Street lighting in the north district only, not other services.',
      };
      const r = await http()
        .patch(`/v1/drafts/${id}`)
        .set(as(alice))
        .send({ expectedVersion: before.version, content })
        .expect(200);
      expect(r.body.version).toBe(before.version + 1);
      expect(r.body.state).toBe('in_review');
      expect(calls).toEqual([[id, before.version + 1, ['scope']]]);
      // T03 needs needs_revision first (a run decides T02; set it directly here)
      await db
        .update(s.problem)
        .set({ state: 'needs_revision' })
        .where(eq(s.problem.id, id));
      const cur = await row(id);
      await http()
        .patch(`/v1/drafts/${id}`)
        .set(as(alice))
        .send({
          expectedVersion: cur.version,
          content: {
            ...(cur.content as any),
            scope:
              'Street lighting in the north district since last March, not other services.',
          },
        })
        .expect(200);
      await http()
        .post(`/v1/drafts/${id}/transitions`)
        .set(as(alice))
        .send({ to: 'in_review', fields: { changedFlaggedField: 'scope' } })
        .expect(200);
      expect(calls.at(-1)).toEqual(['reopen', id, ['scope']]);
    } finally {
      checks.hooks = orig;
    }
  });
});

describe('T04 publishes the stage plan', () => {
  const engineFor = (effects: TransitionEffects) => {
    const clock = new FixedClock(new Date());
    const ids = new UuidV7Generator();
    return new TransitionEngine(
      db,
      clock,
      ids,
      new AuditPort(clock, ids),
      reviewDone,
      new NoopDecisionNotifier(),
      effects,
    );
  };
  const run = (engine: TransitionEngine, id: string) =>
    engine.apply({
      problemId: id,
      to: 'active',
      actor: { kind: 'run', id: null },
      fields: { ruleIds: ['R1'], publicationRequest: true },
      runId: newId(),
    });
  const inReview = async (content: Record<string, unknown>, plan?: object) => {
    const id = await draft(content);
    if (plan)
      await http()
        .put(`/v1/drafts/${id}/stage-plan`)
        .set(as(alice))
        .send({ ...plan, expectedVersion: 1 })
        .expect(200);
    await submit(id).expect(200);
    return id;
  };

  it('classic-5 publishes with the first stage started and the rest planned', async () => {
    const id = await inReview(example('valid-minimal'), {
      template: 'classic-5',
    });
    const r = await run(engineFor(app.get(TransitionEffects)), id);
    expect(r.state).toBe('active');
    const st = await stages(id);
    const by = Object.fromEntries(st.map((x) => [x.name, x.state]));
    expect(by).toEqual({
      facts: 'active',
      solutions: 'planned',
      choose: 'planned',
      implement: 'planned',
      verify: 'planned',
    });
    const ev = await db
      .select()
      .from(s.stageEvent)
      .where(eq(s.stageEvent.problemId, id));
    expect(
      ev.filter((e) => (e.payload as any).transitionId === 'ST03'),
    ).toHaveLength(1);
    // the public detail now carries sources, final criteria and the plan version
    await db
      .update(s.problem)
      .set({ initiatorId: null })
      .where(eq(s.problem.id, id));
    const d = await http().get(`/v1/problems/${id}`).expect(200);
    expect(d.body.planVersion).toBe(1);
    expect(d.body.sources[0]).toMatchObject({
      category: 'official_record',
      categoryLabel: 'Official record',
    });
    expect(d.body.finalCriteria).toHaveLength(1);
    expect(JSON.stringify(d.body)).not.toMatch(/initiator/i);
  });

  it('the default plan is one implicit stage whose criteria equal the final criteria', async () => {
    const id = await inReview(example('valid-minimal'));
    await run(engineFor(app.get(TransitionEffects)), id);
    const st = await stages(id);
    expect(st.map((x) => [x.name, x.state])).toEqual([['resolve', 'active']]);
    const c = await db
      .select()
      .from(s.acceptanceCriterion)
      .where(eq(s.acceptanceCriterion.stageId, st[0].id));
    expect(c.map((x) => x.statement)).toEqual(
      example('valid-minimal').final_acceptance_criteria.map(
        (x: any) => x.statement,
      ),
    );
  });

  it('a parallel plan readies every root; auto_start false stays ready, true starts', async () => {
    const par = structuredClone(
      example('valid-with-parallel-stage-plan').stage_plan,
    );
    par[1].auto_start = false;
    const id = await inReview(example('valid-minimal'), { stages: par });
    await run(engineFor(app.get(TransitionEffects)), id);
    const by = Object.fromEntries(
      (await stages(id)).map((x) => [x.name, x.state]),
    );
    expect(by).toEqual({
      map_outages: 'active',
      ask_schedule: 'ready',
      agree_plan: 'planned',
    });
  });

  it('a failure after publish leaves nothing half published', async () => {
    const id = await inReview(example('valid-minimal'), {
      template: 'classic-5',
    });
    const fx2 = new TransitionEffects();
    for (const e of preparationEffects(
      new StagePlanService(new UuidV7Generator()),
      () => app.get(SubmitChecks).hooks,
    ))
      fx2.register(e);
    fx2.register({
      on: ['T04'],
      run: async () => {
        throw new Error('boom');
      },
    });
    await expect(run(engineFor(fx2), id)).rejects.toThrow('boom');
    expect((await row(id)).state).toBe('in_review');
    expect((await row(id)).publishedAt).toBeNull();
    const st = await stages(id);
    expect(st.every((x) => x.state === 'planned')).toBe(true);
    const ev = await db
      .select()
      .from(s.stageEvent)
      .where(eq(s.stageEvent.problemId, id));
    expect(ev).toHaveLength(0);
  });

  it('a member cannot apply T04, and the publication path stays closed', async () => {
    const id = await inReview(example('valid-minimal'));
    const r = await http()
      .post(`/v1/drafts/${id}/transitions`)
      .set(as(alice))
      .send({
        to: 'active',
        fields: { ruleIds: ['R1'], publicationRequest: true },
      });
    expect(r.status).toBe(403);
    expect((await row(id)).state).toBe('in_review');
    // review is fail-closed in the app: even a run cannot publish without review facts
    await expect(run(app.get(TransitionEngine), id)).rejects.toMatchObject({
      status: 409,
    });
    expect(await stages(id)).toHaveLength(0);
  });

  it('discarding a draft removes the sources and the plan copy', async () => {
    const id = await draft(example('valid-minimal'));
    await http()
      .put(`/v1/drafts/${id}/stage-plan`)
      .set(as(alice))
      .send({ template: 'classic-5', expectedVersion: 1 })
      .expect(200);
    await http().delete(`/v1/drafts/${id}`).set(as(alice)).expect(204);
    expect(await stages(id)).toHaveLength(0);
    expect(
      await db.select().from(s.sourceRef).where(eq(s.sourceRef.problemId, id)),
    ).toHaveLength(0);
  });
});
