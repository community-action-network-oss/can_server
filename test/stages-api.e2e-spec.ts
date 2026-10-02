import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { planFromWire } from '../src/stages/app/plan-wire.js';
import { CHOICE_GATE } from '../src/stages/app/ports.js';
import { STAGE_PLAN_REPO } from '../src/stages/app/stage-plan.repository.js';
import { DbStageChips } from '../src/stages/infra/stage-chips.js';
import { writeFixture } from './policy/build-fixture.ts';
import { FIXTURE_DIR } from './policy/helpers.js';
import { ProblemFixtures } from './support/problems.js';

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
const tokens: Record<string, string> = {};
let poster: string;
let bob: string;
let steward: string;
let pid: string; // published, active problem
let draftPid: string;
const ids: Record<string, string> = {};

const http = () => request(app.getHttpServer());
const as = (a: string) => ({ Authorization: `Bearer ${tokens[a]}` });
async function signedIn(role = 'member'): Promise<string> {
  const id = await fx.account();
  const token = newToken();
  tokens[id] = token;
  await db.update(s.account).set({ role }).where(eq(s.account.id, id));
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

const crit = (statement: string) => ({
  statement,
  measure: 'met_or_not',
});
const wirePlan = () =>
  planFromWire(
    [
      {
        name: 'map_faults',
        label: 'Map the faults',
        goal: 'Know which poles are dark on the ring road.',
        acceptance_criteria: [
          crit('Every pole has a recorded status'),
          crit('A map is posted'),
        ],
      },
      {
        name: 'fix_feed',
        label: 'Fix the feed',
        goal: 'Repair the cable feed that darkens the road.',
        acceptance_criteria: [crit('The road is lit for 30 nights')],
        depends_on: ['map_faults'],
      },
      {
        name: 'check_result',
        goal: 'Check the road stayed lit after the repair.',
        acceptance_criteria: [crit('No outage reports for 30 days')],
        depends_on: ['fix_feed'],
        needs_choice: false,
      },
    ],
    [
      {
        statement: 'The ring road stays lit every night.',
        how_observed: 'Council fault log shows no outage.',
      },
    ],
  );

const option = (ref: string, over: object = {}) => ({
  stage_ref: ref,
  option_statement:
    'Run a two week volunteer survey that marks every dark light on a shared sheet.',
  mechanism:
    'Volunteers walk set sections after dusk and record each unlit pole by number.',
  responsible_role: 'Neighbourhood volunteer team',
  authority_and_legal_basis:
    'Public road walking needs no permit, and pole numbers are public asset data.',
  cost_estimate: { band: 'none' },
  how_it_meets_stage_criteria: [
    {
      criterion_ref: 1,
      how: 'Every pole on the ring road has a recorded status after the second week.',
    },
  ],
  risks_and_rights_impact:
    'Walkers may be mistaken for loiterers after dark. Walk in pairs and carry a team card.',
  lawful_alternatives: ['Ask the council to share its own inspection list.'],
  assumptions: [],
  ...over,
});
const choice = (ref: string, optionIds: string[], over: object = {}) => ({
  stage_ref: ref,
  chosen_option_ids: optionIds,
  decision_method: 'poster_after_input',
  decider_role: 'Problem poster',
  authority:
    'The stage plan names the poster as decider after community input.',
  rationale:
    'This option meets both criteria and costs less than the other ways.',
  legal_gate_record: {
    constraint_checked:
      'The works fit the municipal roads act and the district mandate.',
    source_ref: 'https://example.org/roads-act',
    layer: 'both',
    result: 'passed',
  },
  ...over,
});
const evidence = (ref: string, over: object = {}) => ({
  stage_ref: ref,
  criterion_ref: 1,
  evidence_refs: [
    {
      url: 'https://example.org/lowmere/repair-log',
      description: 'Council repair log entry for the ring road feed.',
    },
  ],
  observation_date: '2026-03-31',
  outcome_statement:
    'The log shows no outage report on the ring road for 31 days after the repair.',
  what_the_evidence_does_not_show: 'It covers the ring road only.',
  ...over,
});

beforeAll(async () => {
  // A fixture pack that also carries the three stage content schemas from can_policy.
  const tmp = mkdtempSync(join(tmpdir(), 'stages-fixture-'));
  cpSync(FIXTURE_DIR, tmp, { recursive: true });
  // can_policy schemas carry id/version/pack, which the server's strict Ajv rejects; fixture copies use $id like the problem fixture.
  for (const t of ['stage_option', 'stage_choice', 'stage_evidence']) {
    const dir = join(tmp, 'base@0.0.1/content-schemas', t);
    cpSync(join(process.cwd(), '../can_policy/content-schemas', t), dir, {
      recursive: true,
    });
    const f = join(dir, 'schema.json');
    const {
      id,
      version: _v,
      pack: _p,
      ...rest
    } = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(
      f,
      JSON.stringify({ $id: `fixture.${id}`, ...rest }, null, 2),
    );
  }
  const h = writeFixture(tmp)['fiktiva-city'];
  config.policyPacksDir = tmp;
  config.policyActive = {
    default: { name: 'fiktiva-city', version: '0.0.1', hash: h },
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
  poster = await signedIn();
  bob = await signedIn();
  steward = await signedIn('moderator');
  pid = await fx.problem('draft', { initiatorId: poster });
  draftPid = await fx.problem('draft', { initiatorId: poster });
  const repo = app.get(STAGE_PLAN_REPO);
  await repo.savePlan(pid, wirePlan());
  await repo.savePlan(draftPid, wirePlan());
  // Publish the first problem and start its first stage (the start transition is 12-u06).
  await db
    .update(s.problem)
    .set({ state: 'active', publishedAt: new Date() })
    .where(eq(s.problem.id, pid));
  for (const r of await db
    .select()
    .from(s.stage)
    .where(eq(s.stage.problemId, pid)))
    ids[r.name] = r.id;
  await db
    .update(s.stage)
    .set({ state: 'active' })
    .where(eq(s.stage.id, ids.map_faults));
  await db
    .update(s.stage)
    .set({ state: 'planned' })
    .where(eq(s.stage.id, ids.fix_feed));
});

afterAll(async () => {
  await app.close();
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
      .delete(s.stageEvidence)
      .where(inArray(s.stageEvidence.stageId, st));
    await db.delete(s.stageChoice).where(inArray(s.stageChoice.stageId, st));
    await db.delete(s.stageOption).where(inArray(s.stageOption.stageId, st));
    await db
      .delete(s.acceptanceCriterion)
      .where(inArray(s.acceptanceCriterion.stageId, st));
    await db.delete(s.stageEdge).where(inArray(s.stageEdge.stageId, st));
  }
  await db
    .delete(s.acceptanceCriterion)
    .where(inArray(s.acceptanceCriterion.problemId, all));
  if (st.length) await db.delete(s.stage).where(inArray(s.stage.id, st));
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

describe('stage map and visibility', () => {
  it('hides an unpublished plan from guests and others, shows it to the poster', async () => {
    await http().get(`/v1/stages/by-problem/${draftPid}`).expect(404);
    await http()
      .get(`/v1/stages/by-problem/${draftPid}`)
      .set(as(bob))
      .expect(404);
    await http()
      .get(`/v1/stages/by-problem/${draftPid}`)
      .set(as(poster))
      .expect(200);
    const [d] = await db
      .select()
      .from(s.stage)
      .where(eq(s.stage.problemId, draftPid));
    await http().get(`/v1/stages/${d.id}`).expect(404);
    await http().get('/v1/stages/by-problem/nope').expect(404);
  });

  it('a guest reads nodes and edges in topological order, with exact key sets', async () => {
    const r = await http().get(`/v1/stages/by-problem/${pid}`).expect(200);
    expect(Object.keys(r.body).sort()).toEqual([
      'activeStages',
      'edges',
      'finalCriteria',
      'label',
      'planVersion',
      'problemId',
      'problemState',
      'stages',
    ]);
    expect(r.body.stages.map((x: { name: string }) => x.name)).toEqual([
      'map_faults',
      'fix_feed',
      'check_result',
    ]);
    expect(r.body.stages.map((x: { chip: string }) => x.chip)).toEqual([
      'In progress',
      'Planned',
      'Planned',
    ]);
    expect(r.body.label).toBe('Active: stage Map the faults');
    expect(r.body.edges).toEqual([
      { from: ids.map_faults, to: ids.fix_feed },
      { from: ids.fix_feed, to: ids.check_result },
    ]);
    expect(Object.keys(r.body.stages[0]).sort()).toEqual([
      'chip',
      'criteriaTotal',
      'criteriaWithEvidence',
      'current',
      'decisionMethod',
      'dependsOn',
      'goal',
      'id',
      'label',
      'name',
      'needsChoice',
      'ordinal',
      'required',
      'state',
    ]);
    expect(r.body.finalCriteria).toEqual([
      {
        ref: 1,
        statement: 'The ring road stays lit every night.',
        measure: 'Council fault log shows no outage.',
        deadline: null,
      },
    ]);
    expect(JSON.stringify(r.body)).not.toMatch(/email|initiator/i);
  });

  it('serves the workspace with 1-based criterion refs and allowed contribution types', async () => {
    const r = await http().get(`/v1/stages/${ids.fix_feed}`).expect(200);
    expect(Object.keys(r.body).sort()).toEqual([
      'allowedContributionTypes',
      'chip',
      'choice',
      'criteria',
      'decisionMethod',
      'evidence',
      'goal',
      'id',
      'label',
      'name',
      'needsChoice',
      'options',
      'planVersion',
      'problemId',
      'required',
      'state',
      'tasks',
    ]);
    expect(r.body.allowedContributionTypes).toContain('proposed_solution');
    expect(r.body.allowedContributionTypes).not.toContain('progress_update');
    expect(r.body.criteria[0]).toMatchObject({ ref: 1, hasEvidence: false });
  });

  it('refuses a plan with a cycle and refuses edits after publication', async () => {
    const p = wirePlan();
    p.stages[0].dependsOn = ['check_result'];
    const repo = app.get(STAGE_PLAN_REPO);
    await expect(repo.savePlan(draftPid, p)).rejects.toMatchObject({
      status: 400,
    });
    await expect(repo.savePlan(pid, wirePlan())).rejects.toMatchObject({
      status: 409,
    });
    // the failed save left the draft plan intact
    expect((await repo.loadPlan(draftPid))!.plan.stages).toHaveLength(3);
  });

  it('DbStageChips reports the stages in progress', async () => {
    const chips = await new DbStageChips(db).chips([pid, draftPid]);
    expect(chips.get(pid)).toEqual({ kind: 'one', name: 'Map the faults' });
    expect(chips.has(draftPid)).toBe(false);
  });
});

describe('options', () => {
  it('needs a session', async () => {
    await http()
      .post(`/v1/stages/${ids.map_faults}/options`)
      .send({ content: option('map_faults') })
      .expect(401);
  });

  it('stores an option on a planned stage as for_later_stage, hidden from others until public', async () => {
    const r = await http()
      .post(`/v1/stages/${ids.fix_feed}/options`)
      .set(as(bob))
      .send({ content: option('fix_feed') })
      .expect(201);
    expect(r.body).toMatchObject({
      status: 'pending',
      forLaterStage: true,
      stageId: ids.fix_feed,
    });
    expect(Object.keys(r.body).sort()).toEqual([
      'authorHandle',
      'content',
      'createdAt',
      'forLaterStage',
      'id',
      'stageId',
      'status',
    ]);
    ids.laterOption = r.body.id;
    expect(
      (await http().get(`/v1/stages/${ids.fix_feed}`).expect(200)).body.options,
    ).toEqual([]);
    expect(
      (await http().get(`/v1/stages/${ids.fix_feed}`).set(as(bob))).body
        .options,
    ).toHaveLength(1);
    await http().get(`/v1/stage-options/${ids.laterOption}`).expect(404);
    await http()
      .get(`/v1/stage-options/${ids.laterOption}`)
      .set(as(bob))
      .expect(200);
    const [{ n }] = (
      await pool.query(
        'select count(*)::int n from stage_event where stage_id=$1 and type=$2',
        [ids.fix_feed, 'option_added'],
      )
    ).rows;
    expect(n).toBe(1);
  });

  it('keeps for_later_stage false on an active stage, and rejects bad content', async () => {
    const ok = await http()
      .post(`/v1/stages/${ids.map_faults}/options`)
      .set(as(bob))
      .send({ content: option('map_faults') })
      .expect(201);
    expect(ok.body.forLaterStage).toBe(false);
    ids.option = ok.body.id;
    const schema = await http()
      .post(`/v1/stages/${ids.map_faults}/options`)
      .set(as(bob))
      .send({ content: option('map_faults', { lawful_alternatives: [] }) })
      .expect(400);
    expect(schema.body.error.code).toBe('schema_invalid');
    const wrong = await http()
      .post(`/v1/stages/${ids.map_faults}/options`)
      .set(as(bob))
      .send({ content: option('fix_feed') })
      .expect(400);
    expect(wrong.body.error.fieldErrors['/stage_ref']).toBeTruthy();
    const ref = await http()
      .post(`/v1/stages/${ids.map_faults}/options`)
      .set(as(bob))
      .send({
        content: option('map_faults', {
          how_it_meets_stage_criteria: [
            { criterion_ref: 3, how: 'There is no third criterion at all.' },
          ],
        }),
      })
      .expect(400);
    expect(Object.keys(ref.body.error.fieldErrors)[0]).toMatch(/criterion_ref/);
    await http()
      .post(`/v1/stages/${ids.map_faults}/options`)
      .set(as(bob))
      .send({ content: option('map_faults'), extra: 1 })
      .expect(400);
  });

  it('lets only the author edit', async () => {
    const edit = {
      content: option('map_faults', {
        mechanism: 'Volunteers walk sections after dusk, in pairs.',
      }),
    };
    await http()
      .patch(`/v1/stage-options/${ids.option}`)
      .set(as(poster))
      .send(edit)
      .expect(404);
    const r = await http()
      .patch(`/v1/stage-options/${ids.option}`)
      .set(as(bob))
      .send(edit)
      .expect(200);
    expect(r.body.content.mechanism).toMatch(/in pairs/);
  });
});

describe('choice', () => {
  it('gives a non-decider 403, and not_ready on a planned stage', async () => {
    await db
      .update(s.stageOption)
      .set({ status: 'public' })
      .where(eq(s.stageOption.id, ids.option));
    const body = (st: string, o: string) => ({ content: choice(st, [o]) });
    await http()
      .post(`/v1/stages/${ids.map_faults}/choice`)
      .set(as(bob))
      .send(body('map_faults', ids.option))
      .expect(403);
    const early = await http()
      .post(`/v1/stages/${ids.fix_feed}/choice`)
      .set(as(poster))
      .send(body('fix_feed', ids.laterOption))
      .expect(409);
    expect(early.body.error.code).toBe('not_ready');
    await http()
      .post(`/v1/stages/${ids.map_faults}/choice`)
      .send(body('map_faults', ids.option))
      .expect(401);
  });

  it('stores nothing when the gate holds, then records, then refuses a second', async () => {
    const gate = app.get(CHOICE_GATE);
    const real = gate.check;
    gate.check = async () => ({ result: 'held', layer: 'both' });
    const held = await http()
      .post(`/v1/stages/${ids.map_faults}/choice`)
      .set(as(poster))
      .send({ content: choice('map_faults', [ids.option]) })
      .expect(409);
    gate.check = real;
    expect(held.body.error.code).toBe('gate_held');
    expect(
      await db
        .select()
        .from(s.stageChoice)
        .where(eq(s.stageChoice.stageId, ids.map_faults)),
    ).toHaveLength(0);

    const bad = await http()
      .post(`/v1/stages/${ids.map_faults}/choice`)
      .set(as(poster))
      .send({ content: choice('map_faults', [ids.laterOption]) })
      .expect(400);
    expect(bad.body.error.fieldErrors['/chosen_option_ids']).toBeTruthy();

    const ok = await http()
      .post(`/v1/stages/${ids.map_faults}/choice`)
      .set(as(poster))
      .send({ content: choice('map_faults', [ids.option]) })
      .expect(201);
    expect(Object.keys(ok.body).sort()).toEqual([
      'authority',
      'createdAt',
      'deciderRole',
      'decisionMethod',
      'dissentNotes',
      'gateResult',
      'id',
      'optionIds',
      'rationale',
      'steps',
    ]);
    expect(ok.body.optionIds).toEqual([ids.option]);
    await http()
      .post(`/v1/stages/${ids.map_faults}/choice`)
      .set(as(poster))
      .send({ content: choice('map_faults', [ids.option]) })
      .expect(409);
    expect(
      (await http().get(`/v1/stages/${ids.map_faults}`)).body.choice.id,
    ).toBe(ok.body.id);
  });

  it('withdraws a choice, only by the decider, and a stage that needs no choice takes none', async () => {
    await http()
      .delete(`/v1/stages/${ids.map_faults}/choice`)
      .set(as(bob))
      .expect(403);
    await http()
      .delete(`/v1/stages/${ids.map_faults}/choice`)
      .set(as(poster))
      .expect(204);
    await http()
      .delete(`/v1/stages/${ids.map_faults}/choice`)
      .set(as(poster))
      .expect(404);
    expect(
      (await http().get(`/v1/stages/${ids.map_faults}`)).body.choice,
    ).toBeNull();
    await db
      .update(s.stage)
      .set({ state: 'active' })
      .where(eq(s.stage.id, ids.check_result));
    await http()
      .post(`/v1/stages/${ids.check_result}/choice`)
      .set(as(poster))
      .send({ content: choice('check_result', [ids.option]) })
      .expect(409);
    await db
      .update(s.stage)
      .set({ state: 'planned' })
      .where(eq(s.stage.id, ids.check_result));
  });

  it('lets a steward decide for a steward stage', async () => {
    await db
      .update(s.stage)
      .set({ decisionMethod: 'steward' })
      .where(eq(s.stage.id, ids.map_faults));
    await http()
      .post(`/v1/stages/${ids.map_faults}/choice`)
      .set(as(poster))
      .send({
        content: choice('map_faults', [ids.option], {
          decision_method: 'steward',
        }),
      })
      .expect(403);
    await http()
      .post(`/v1/stages/${ids.map_faults}/choice`)
      .set(as(steward))
      .send({
        content: choice('map_faults', [ids.option], {
          decision_method: 'steward',
        }),
      })
      .expect(201);
    await db
      .update(s.stageChoice)
      .set({ withdrawnAt: new Date() })
      .where(eq(s.stageChoice.stageId, ids.map_faults));
    await db
      .update(s.stage)
      .set({ decisionMethod: 'poster_after_input' })
      .where(eq(s.stage.id, ids.map_faults));
  });
});

describe('evidence', () => {
  const post = (id: string, content: object, who = bob) =>
    http().post(`/v1/stages/${id}/evidence`).set(as(who)).send({ content });

  it('is refused on a planned stage (STAGE-PREP-1 and STAGE-GATE-1)', async () => {
    const r = await post(ids.fix_feed, evidence('fix_feed')).expect(409);
    expect(r.body.error.code).toBe('not_ready');
  });

  it('needs an https URL and a valid criterion', async () => {
    const http1 = await post(
      ids.map_faults,
      evidence('map_faults', {
        evidence_refs: [
          {
            url: 'http://example.org/log',
            description: 'A plain http link to the log.',
          },
        ],
      }),
    ).expect(400);
    expect(http1.body.error.fieldErrors['/evidence_refs/0/url']).toBeTruthy();
    const c = await post(
      ids.map_faults,
      evidence('map_faults', { criterion_ref: 5 }),
    ).expect(400);
    expect(Object.keys(c.body.error.fieldErrors).length).toBeGreaterThan(0);
    const c3 = await post(
      ids.map_faults,
      evidence('map_faults', { criterion_ref: 3 }),
    ).expect(400);
    expect(c3.body.error.fieldErrors['/criterion_ref']).toBeTruthy();
    await http()
      .post(`/v1/stages/${ids.map_faults}/evidence`)
      .send({ content: evidence('map_faults') })
      .expect(401);
  });

  it('records evidence against a criterion and shows hasEvidence', async () => {
    const r = await post(
      ids.map_faults,
      evidence('map_faults', { criterion_ref: 2 }),
    ).expect(201);
    expect(Object.keys(r.body.items[0]).sort()).toEqual([
      'authorHandle',
      'createdAt',
      'criterionRefs',
      'description',
      'id',
      'tier',
      'url',
    ]);
    expect(r.body.items[0].criterionRefs).toEqual([2]);
    const w = (await http().get(`/v1/stages/${ids.map_faults}`)).body;
    expect(
      w.criteria.map((c: { hasEvidence: boolean }) => c.hasEvidence),
    ).toEqual([false, true]);
    expect(w.evidence).toHaveLength(1);
    const m = (await http().get(`/v1/stages/by-problem/${pid}`)).body;
    expect(m.stages[0].criteriaWithEvidence).toBe(1);
  });
});

describe('stage_event', () => {
  it('is append-only for can_app_rw', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role can_app_rw');
      for (const sql of [
        'update stage_event set type=$1',
        'delete from stage_event',
      ]) {
        await c.query('savepoint s');
        await expect(
          c.query(sql, sql.startsWith('update') ? ['x'] : []),
        ).rejects.toThrow(/permission denied/);
        await c.query('rollback to s');
      }
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('wrote one event per write, in the same transaction as the write', async () => {
    const types = (
      await pool.query(
        'select type from stage_event where stage_id=$1 order by occurred_at',
        [ids.map_faults],
      )
    ).rows.map((r) => r.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'option_added',
        'option_updated',
        'choice_recorded',
        'choice_withdrawn',
        'evidence_added',
      ]),
    );
  });
});
