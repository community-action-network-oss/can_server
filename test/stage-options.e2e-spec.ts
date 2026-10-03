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
import { planFromWire } from '../src/stages/app/plan-wire.js';
import {
  CONTRIBUTION_PUBLISHED_HOOK,
  type ContributionPublishedHook,
} from '../src/contributions/app/evidence-tier.service.js';
import { STAGE_PLAN_REPO } from '../src/stages/app/stage-plan.repository.js';
import { ratifiedV1 } from './policy/helpers.js';
import { ProblemFixtures } from './support/problems.js';

const saved = { dir: config.policyPacksDir, active: config.policyActive };
const EX = join(
  process.cwd(),
  'test/fixtures/policy-v1/base@1.0.0/content-schemas',
);
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
let stageId: string;
let pid: string;
let owner: string;

const http = () => request(app.getHttpServer());
const person = async (role = 'member') => {
  const id = await fx.account();
  const token = newToken();
  await db.update(s.account).set({ role }).where(eq(s.account.id, id));
  await db.insert(s.session).values({
    id: newId(),
    accountId: id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000),
    clientKind: 'native',
  });
  return { id, h: { Authorization: `Bearer ${token}` } };
};
const optionBody = (): Record<string, unknown> => ({
  stage_ref: 'map_faults',
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
});
const viaOption = (p: { h: Record<string, string> }) =>
  http()
    .post(`/v1/stages/${stageId}/options`)
    .set(p.h)
    .send({ content: optionBody() });

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
  owner = (await person()).id;
  pid = await fx.problem('draft', { initiatorId: owner });
  await app.get(STAGE_PLAN_REPO).savePlan(
    pid,
    planFromWire(
      [
        {
          name: 'map_faults',
          label: 'Map the faults',
          goal: 'Know which poles are dark on the ring road.',
          acceptance_criteria: [
            {
              statement: 'Every pole has a recorded status',
              measure: 'met_or_not',
            },
          ],
        },
      ],
      [
        {
          statement: 'The ring road stays lit every night.',
          how_observed: 'Council fault log shows no outage.',
        },
      ],
    ),
  );
  await db
    .update(s.problem)
    .set({ state: 'active', publishedAt: new Date() })
    .where(eq(s.problem.id, pid));
  const [st] = await db
    .select()
    .from(s.stage)
    .where(eq(s.stage.problemId, pid));
  stageId = st!.id;
  await db
    .update(s.stage)
    .set({ state: 'active' })
    .where(eq(s.stage.id, stageId));
});

afterAll(async () => {
  await app.close();
  config.policyPacksDir = saved.dir;
  config.policyActive = saved.active;
  const all = fx.problems;
  await db.delete(s.stageEvent).where(eq(s.stageEvent.stageId, stageId));
  await db.delete(s.stageChoice).where(eq(s.stageChoice.stageId, stageId));
  await db.delete(s.stageEvidence).where(eq(s.stageEvidence.stageId, stageId));
  const cs = await db
    .select({ id: s.contribution.id })
    .from(s.contribution)
    .where(inArray(s.contribution.problemId, all));
  const ids = cs.map((c) => c.id);
  if (ids.length) {
    await db
      .delete(s.evidenceRef)
      .where(inArray(s.evidenceRef.contributionId, ids));
    await db
      .update(s.contribution)
      .set({ improvesOptionId: null })
      .where(inArray(s.contribution.id, ids));
    await db.delete(s.contribution).where(inArray(s.contribution.id, ids));
  }
  await db.delete(s.stageOption).where(eq(s.stageOption.stageId, stageId));
  await db
    .delete(s.acceptanceCriterion)
    .where(inArray(s.acceptanceCriterion.problemId, all));
  await db
    .delete(s.acceptanceCriterion)
    .where(eq(s.acceptanceCriterion.stageId, stageId));
  await db.delete(s.stage).where(eq(s.stage.id, stageId));
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

const viaPost = (
  p: { h: Record<string, string> },
  type: string,
  extra: Record<string, unknown> = {},
  b: Record<string, unknown> = valid(type),
) =>
  http()
    .post(`/v1/contributions/by-problem/${pid}`)
    .set(p.h)
    .send({ type, body: b, ...extra });
const read = (h: Record<string, string> = {}) =>
  http().get(`/v1/stages/${stageId}/options`).set(h);
const accept = async (contributionId: string) => {
  await db
    .update(s.contribution)
    .set({ status: 'accepted', reviewedAt: new Date() })
    .where(eq(s.contribution.id, contributionId));
  const hook = app.get<ContributionPublishedHook>(CONTRIBUTION_PUBLISHED_HOOK);
  await db.transaction((tx) => hook.onPublished(tx, { contributionId }));
};
const rowsFor = (id: string) =>
  db.select().from(s.stageOption).where(eq(s.stageOption.id, id));

describe('stage options (04-u04)', () => {
  let a: Awaited<ReturnType<typeof person>>;
  let b: Awaited<ReturnType<typeof person>>;
  let optA = '';
  let optB = '';
  let contribA = '';

  it('an option from the stage route is one contribution and stays hidden until accepted', async () => {
    a = await person();
    const r = await viaOption(a).expect(201);
    optA = r.body.id;
    const [o] = await rowsFor(optA);
    contribA = o!.contributionId!;
    const mine = await db
      .select()
      .from(s.contribution)
      .where(eq(s.contribution.authorId, a.id));
    expect(mine).toHaveLength(1);

    expect((await read().expect(200)).body.items).toHaveLength(0);
    const own = (await read(a.h).expect(200)).body.items;
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ id: optA, pendingReview: true });
  });

  it('acceptance publishes the option without a second contribution or a second reply', async () => {
    await accept(contribA);
    await accept(contribA); // idempotent
    const [o] = await rowsFor(optA);
    expect(o!.status).toBe('public');
    const mine = await db
      .select()
      .from(s.contribution)
      .where(eq(s.contribution.authorId, a.id));
    expect(mine).toHaveLength(1);
    const pub = (await read().expect(200)).body;
    expect(pub.items).toHaveLength(1);
    expect(pub.items[0].pendingReview).toBe(false);
    expect(pub.comparison).toBeNull();
  });

  it('an option from the contribution route lands in the same read, in creation order, with a comparison', async () => {
    b = await person();
    const r = await viaPost(b, 'proposed_solution', { stageId }).expect(201);
    const [o] = await db
      .select()
      .from(s.stageOption)
      .where(eq(s.stageOption.contributionId, r.body.id));
    optB = o!.id;
    await accept(r.body.id);
    const res = (await read().expect(200)).body;
    expect(res.items.map((i: { id: string }) => i.id)).toEqual([optA, optB]);
    expect(res.criteria).toEqual({
      order: 'created_at_asc',
      usesEngagementSignals: false,
    });
    expect(Object.keys(res).sort()).toEqual([
      'comparison',
      'criteria',
      'items',
    ]);
    expect(Object.keys(res.items[0]).sort()).toEqual([
      'authorHandle',
      'content',
      'createdAt',
      'forLaterStage',
      'id',
      'improvements',
      'pendingReview',
      'stageId',
      'status',
    ]);
    expect(res.comparison.rows.map((x: { field: string }) => x.field)).toEqual([
      'mechanism',
      'authority',
      'cost',
      'risks',
    ]);
    expect(res.comparison.rows[0].cells).toHaveLength(2);
    expect(res.comparison.rows[2].cells[0].value).toBe('none');
  });

  it('a proposed_solution without a stage is never an option', async () => {
    const c = await person();
    const r = await viaPost(c, 'proposed_solution').expect(201);
    const o = await db
      .select()
      .from(s.stageOption)
      .where(eq(s.stageOption.contributionId, r.body.id));
    expect(o).toHaveLength(0);
  });

  it('an improvement attaches to a public option and refuses anything else', async () => {
    const c = await person();
    const body = { ...valid('proposal_improvement'), improves: optA };
    await viaPost(
      c,
      'proposal_improvement',
      { stageId },
      {
        ...body,
        improves: newId(),
      },
    ).expect(400);
    await viaPost(c, 'proposal_improvement', {}, body).expect(400);
    const r = await viaPost(
      c,
      'proposal_improvement',
      { stageId },
      body,
    ).expect(201);
    const own = (await read(c.h).expect(200)).body.items[0];
    expect(own.improvements).toMatchObject([
      { id: r.body.id, pendingReview: true },
    ]);
    expect((await read().expect(200)).body.items[0].improvements).toHaveLength(
      0,
    );
    await accept(r.body.id);
    const pub = (await read().expect(200)).body.items[0];
    expect(pub.improvements).toMatchObject([
      { id: r.body.id, pendingReview: false },
    ]);
  });

  it('withdrawing the parent keeps its improvements readable and hides its content', async () => {
    await http()
      .patch(`/v1/contributions/${contribA}`)
      .set(a.h)
      .send({ withdraw: true })
      .expect(200);
    const res = (await read().expect(200)).body;
    const first = res.items.find((i: { id: string }) => i.id === optA);
    expect(first).toMatchObject({ status: 'withdrawn', content: null });
    expect(first.improvements).toHaveLength(1);
    expect(res.comparison).toBeNull();
  });

  it('the author edits a public option until a choice stands, then it is read only', async () => {
    const patch = () =>
      http()
        .patch(`/v1/stage-options/${optB}`)
        .set(b.h)
        .send({ content: optionBody() });
    await patch().expect(200);
    await db.insert(s.stageChoice).values({
      id: newId(),
      stageId,
      optionIds: [optB],
      decisionMethod: 'steward_decides',
      deciderId: owner,
      authority: 'x',
      rationale: 'x',
      content: {},
      createdAt: new Date(),
    });
    await patch().expect(409);
  });

  it('the options read hides a private problem from strangers', async () => {
    await db
      .update(s.problem)
      .set({ publishedAt: null, state: 'draft' })
      .where(eq(s.problem.id, pid));
    await read().expect(404);
    await db
      .update(s.problem)
      .set({ state: 'active', publishedAt: new Date() })
      .where(eq(s.problem.id, pid));
  });
});
