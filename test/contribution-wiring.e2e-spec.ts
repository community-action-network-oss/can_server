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
const viaContribution = (
  p: { h: Record<string, string> },
  type = 'observation',
) =>
  http()
    .post(`/v1/contributions/by-problem/${pid}`)
    .set(p.h)
    .send({ type, body: valid(type) });
const viaOption = (p: { h: Record<string, string> }, type = 'observation') =>
  http()
    .post(`/v1/stages/${stageId}/options`)
    .set(p.h)
    .send({
      content: {
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
        lawful_alternatives: [
          'Ask the council to share its own inspection list.',
        ],
        assumptions: [],
      },
    });

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
  await db.delete(s.stageOption).where(eq(s.stageOption.stageId, stageId));
  const cs = await db
    .select({ id: s.contribution.id })
    .from(s.contribution)
    .where(inArray(s.contribution.problemId, all));
  const ids = cs.map((c) => c.id);
  if (ids.length) {
    await db
      .delete(s.evidenceRef)
      .where(inArray(s.evidenceRef.contributionId, ids));
    await db.delete(s.contribution).where(inArray(s.contribution.id, ids));
  }
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

describe('contribution wiring (D-85)', () => {
  it('stage options and contributions share one cap, and either path gets 429 on the 5th', async () => {
    const a = await person();
    await viaContribution(a, 'progress_update').expect(201);
    await viaOption(a).expect(201);
    await viaContribution(a, 'verification_evidence').expect(201);
    await viaOption(a).expect(201);
    for (const send of [
      () => viaContribution(a, 'progress_update'),
      () => viaOption(a),
    ]) {
      const r = await send().expect(429);
      expect(r.body.error).toMatchObject({
        code: 'reply_limit_reached',
        limit: 4,
        remaining: 0,
      });
    }
  });
});

describe('allowedContributionTypes on problem detail', () => {
  it('is empty for guests and lists the problem-level types for a signed-in caller', async () => {
    const g = await http().get(`/v1/problems/${pid}`).expect(200);
    expect(g.body.allowedContributionTypes).toEqual([]);
    const a = await person();
    const r = await http().get(`/v1/problems/${pid}`).set(a.h).expect(200);
    expect(r.body.allowedContributionTypes).toContain('observation');
    expect(r.body.allowedContributionTypes).not.toContain(
      'moderation_feedback',
    );
  });
});
