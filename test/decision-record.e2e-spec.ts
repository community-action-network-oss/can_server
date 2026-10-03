import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, newToken } from '../src/accounts/infra/crypto.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { config } from '../src/config.js';
import * as s from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { LegalLayerMissing } from '../src/policy/legal/corpus.js';
import type { LegalStackLayer } from '../src/policy/legal/corpus.js';
import { LegalRegistry } from '../src/policy/legal/registry.js';
import { planFromWire } from '../src/stages/app/plan-wire.js';
import { STAGE_PLAN_REPO } from '../src/stages/app/stage-plan.repository.js';
import { ratifiedV1 } from './policy/helpers.js';
import { FIKTIVA_DIRS, dirOf } from './policy-legal/support.js';
import { ProblemFixtures } from './support/problems.js';

const saved = { dir: config.policyPacksDir, active: config.policyActive };

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
let stack: LegalStackLayer[] = [];
let stackDown = false;
let articleText = '';
const stageIds: string[] = [];

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
let poster: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;

/** An active problem with one active stage and one public option. */
async function world(
  title: string,
  over: Partial<typeof s.stage.$inferInsert> = {},
) {
  const pid = await fx.problem('draft', { initiatorId: poster.id, title });
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
      [{ statement: 'The ring road stays lit.', how_observed: 'Fault log.' }],
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
  await db
    .update(s.stage)
    .set({ state: 'active', ...over })
    .where(eq(s.stage.id, st.id));
  stageIds.push(st.id);
  const optionId = newId();
  await db.insert(s.stageOption).values({
    id: optionId,
    stageId: st.id,
    authorId: bob.id,
    mechanism: 'Volunteers walk set sections after dusk.',
    risks: 'Walkers may be mistaken for loiterers.',
    content: { responsible_role: 'Neighbourhood volunteer team' },
    status: 'public',
    createdAt: new Date(),
  });
  return { pid, stageId: st.id, optionId };
}
const body = (w: { optionId: string }, over: object = {}) => ({
  content: {
    stage_ref: 'map_faults',
    chosen_option_ids: [w.optionId],
    decision_method: 'poster_after_input',
    decider_role: 'Problem poster',
    authority:
      'The stage plan names the poster as decider after community input.',
    rationale: 'This option meets the criterion and costs the least.',
    legal_gate_record: {
      constraint_checked:
        'The works fit the municipal roads act and the district mandate.',
      source_ref: 'https://example.org/roads-act',
      layer: 'both',
      result: 'passed',
    },
    ...over,
  },
});
const choose = (
  w: { stageId: string; optionId: string },
  who = poster,
  over: object = {},
) =>
  http().post(`/v1/stages/${w.stageId}/choice`).set(who.h).send(body(w, over));
const decision = (stageId: string) =>
  http().get(`/v1/stages/${stageId}/decision`);
const counts = async (stageId: string) => ({
  records: (
    await db
      .select()
      .from(s.decisionRecord)
      .where(eq(s.decisionRecord.stageId, stageId))
  ).length,
  gates: (
    await db
      .select()
      .from(s.legalGateRecord)
      .where(eq(s.legalGateRecord.stageId, stageId))
  ).length,
  choices: (
    await db
      .select()
      .from(s.stageChoice)
      .where(eq(s.stageChoice.stageId, stageId))
  ).length,
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
  // The invented Fiktiva corpora, loaded in memory (no shared legal_corpus_version rows, so parallel specs do not collide).
  const loader = new LegalRegistry(db, async () => undefined);
  const modes: Record<string, 'binding' | 'reference'> = { L1: 'reference' };
  for (const [l, n] of FIKTIVA_DIRS) {
    const c = await loader.register(dirOf(l, n));
    stack.push({
      layer: c.layer,
      corpus: c,
      mode: modes[c.layer] ?? 'binding',
      indexOnly: c.status === 'index_only',
    });
    if (c.layer === 'L6') articleText = c.articles[0].text.slice(0, 40);
  }
  const fake = {
    register: (dir: string) => loader.register(dir),
    activate: async () => {},
    stackFor: async (): Promise<LegalStackLayer[]> => {
      if (stackDown) throw new LegalLayerMissing('default', 'L4', 'down');
      return stack;
    },
  };
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LegalRegistry)
    .useValue(fake)
    .compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  poster = await person();
  bob = await person();
});

afterAll(async () => {
  await app.close();
  config.policyPacksDir = saved.dir;
  config.policyActive = saved.active;
  // Insert-only tables: the owner switches the guard off for teardown only.
  await pool.query('alter table decision_record disable trigger user');
  await pool.query('alter table legal_gate_record disable trigger user');
  await db
    .delete(s.legalGateRecord)
    .where(inArray(s.legalGateRecord.stageId, stageIds));
  await db
    .delete(s.decisionRecord)
    .where(inArray(s.decisionRecord.stageId, stageIds));
  await pool.query('alter table decision_record enable trigger user');
  await pool.query('alter table legal_gate_record enable trigger user');
  await db.delete(s.stageEvent).where(inArray(s.stageEvent.stageId, stageIds));
  await db
    .delete(s.stageChoice)
    .where(inArray(s.stageChoice.stageId, stageIds));
  await db
    .delete(s.stageOption)
    .where(inArray(s.stageOption.stageId, stageIds));
  await db
    .delete(s.acceptanceCriterion)
    .where(inArray(s.acceptanceCriterion.stageId, stageIds));
  await db.delete(s.stage).where(inArray(s.stage.id, stageIds));
  await db
    .delete(s.acceptanceCriterion)
    .where(inArray(s.acceptanceCriterion.problemId, fx.problems));
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

describe('decision record (04-u05)', () => {
  it('records a clear choice with a layered, cited legal check and no article text', async () => {
    const w = await world('Dark ring road lights');
    const r = await choose(w);
    expect(r.body.gateResult).toEqual({ result: 'passed', layer: 'both' });
    const d = (await decision(w.stageId).expect(200)).body;
    expect(d.choiceGate).toBe('recorded');
    expect(d.items).toHaveLength(1);
    const it0 = d.items[0];
    expect(it0).toMatchObject({
      method: 'poster_after_input',
      withdrawn: false,
      transitional: true,
    });
    expect(it0.decidedUnder).toMatch(/^Decided under policy /);
    expect(it0.transitionalNote).toMatch(/transitional stewardship$/);
    expect(it0.legalGate.outcome).toBe('clear');
    expect(
      it0.legalGate.findings.map((f: { layer: string }) => f.layer),
    ).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
    for (const f of it0.legalGate.findings)
      expect(f.corpus_version).toMatch(
        /^[\w-]+@\d+\.\d+\.\d+(\+[0-9a-f]{12})?$/,
      );
    expect(JSON.stringify(d)).not.toContain(articleText);
    expect(JSON.stringify(d)).not.toContain('"text"');
    expect(await counts(w.stageId)).toEqual({
      records: 1,
      gates: 1,
      choices: 1,
    });
  });

  it('lets only the decider choose', async () => {
    const w = await world('Dark ring road lights');
    await choose(w, bob).expect(403);
    expect(await counts(w.stageId)).toEqual({
      records: 0,
      gates: 0,
      choices: 0,
    });
  });

  it('holds a choice with a missing part and stores nothing', async () => {
    const w = await world('Dark ring road lights');
    const r = await choose(w, poster, { rationale: '   ' });
    expect(r.status).toBe(400);
    expect(await counts(w.stageId)).toEqual({
      records: 0,
      gates: 0,
      choices: 0,
    });
    expect((await decision(w.stageId)).body.choiceGate).toBe('missing');
  });

  it('holds when a legal layer is missing (fail closed) and stores nothing', async () => {
    const w = await world('Dark ring road lights');
    stackDown = true;
    try {
      await choose(w).expect(409);
    } finally {
      stackDown = false;
    }
    expect(await counts(w.stageId)).toEqual({
      records: 0,
      gates: 0,
      choices: 0,
    });
  });

  it('holds when an article is retrieved but no judge has read it (never permission)', async () => {
    const w = await world('Assembly on the square');
    const r = await choose(w);
    expect(r.status).toBe(409);
    expect(r.body.code ?? r.body.error?.code).toBe('gate_held');
    expect(await counts(w.stageId)).toEqual({
      records: 0,
      gates: 0,
      choices: 0,
    });
    expect((await decision(w.stageId)).body.choiceGate).toBe('missing');
  });

  it('a block at any layer stands: gate record kept, choice not kept, stage blocked', async () => {
    const w = await world('Moon-market assembly on the square');
    const r = await choose(w);
    expect(r.status).toBe(409);
    expect(r.body.code ?? r.body.error?.code).toBe('gate_blocked');
    const c = await counts(w.stageId);
    expect(c).toEqual({ records: 0, gates: 1, choices: 0 });
    const [g] = await db
      .select()
      .from(s.legalGateRecord)
      .where(eq(s.legalGateRecord.stageId, w.stageId));
    expect(g.outcome).toBe('blocked');
    expect(g.constraintText).toBeTruthy();
    expect(g.sourceRef).toMatch(/#L6\//);
    const f = g.findings as {
      layer: string;
      finding: string;
      blocks: boolean;
    }[];
    expect(f.find((x) => x.layer === 'L3')?.finding).toBe('unjudged');
    expect(f.find((x) => x.layer === 'L6')).toMatchObject({
      finding: 'constrains',
      blocks: true,
    });
    const [st] = await db
      .select()
      .from(s.stage)
      .where(eq(s.stage.id, w.stageId));
    expect(st.state).toBe('blocked');
  });

  it('a blocked check needs a constraint, a source and a cited layer (DB)', async () => {
    const w = await world('Dark ring road lights');
    const row = {
      id: newId(),
      problemId: w.pid,
      stageId: w.stageId,
      packVersion: 'p@1',
      outcome: 'blocked',
      checkedBy: 'test',
      checkedAt: new Date(),
    };
    const six = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].map((layer) => ({
      layer,
      finding: 'none_found',
      corpus_version: 'c@1.0.0',
      article_ids: [],
      blocks: false,
    }));
    const cited = six.map((f) =>
      f.layer === 'L4'
        ? { ...f, finding: 'constrains', blocks: true, article_ids: ['a'] }
        : f,
    );
    await expect(
      db.insert(s.legalGateRecord).values({ ...row, findings: cited }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(s.legalGateRecord)
        .values({ ...row, findings: six, constraintText: 'x', sourceRef: 'y' }),
    ).rejects.toThrow();
    await db
      .insert(s.legalGateRecord)
      .values({ ...row, findings: cited, constraintText: 'x', sourceRef: 'y' });
    expect((await counts(w.stageId)).gates).toBe(1);
  });

  it('withdraw keeps the old record, marked withdrawn; a new choice writes a new record', async () => {
    const w = await world('Dark ring road lights');
    await choose(w).expect(201);
    await http()
      .delete(`/v1/stages/${w.stageId}/choice`)
      .set(poster.h)
      .expect(204);
    let d = (await decision(w.stageId)).body;
    expect(d.choiceGate).toBe('missing');
    expect(d.items).toHaveLength(1);
    expect(d.items[0].withdrawn).toBe(true);
    await choose(w).expect(201);
    d = (await decision(w.stageId)).body;
    expect(d.choiceGate).toBe('recorded');
    expect(d.items.map((i: { withdrawn: boolean }) => i.withdrawn)).toEqual([
      true,
      false,
    ]);
  });

  it('a stage that needs no choice reads not_needed; a planned stage takes no choice', async () => {
    const w = await world('Dark ring road lights', { needsChoice: false });
    expect((await decision(w.stageId)).body.choiceGate).toBe('not_needed');
    const p = await world('Dark ring road lights', { state: 'planned' });
    await choose(p).expect(409);
    expect(await counts(p.stageId)).toEqual({
      records: 0,
      gates: 0,
      choices: 0,
    });
  });

  it('records cannot be changed or deleted, even by the table owner', async () => {
    const w = await world('Dark ring road lights');
    await choose(w).expect(201);
    await expect(
      pool.query(
        'update decision_record set rationale = $1 where stage_id = $2',
        ['x', w.stageId],
      ),
    ).rejects.toThrow(/insert-only/);
    await expect(
      pool.query('delete from decision_record where stage_id = $1', [
        w.stageId,
      ]),
    ).rejects.toThrow(/insert-only/);
    await expect(
      pool.query(
        'update legal_gate_record set outcome = $1 where stage_id = $2',
        ['clear', w.stageId],
      ),
    ).rejects.toThrow(/insert-only/);
    await expect(
      pool.query('delete from legal_gate_record where stage_id = $1', [
        w.stageId,
      ]),
    ).rejects.toThrow(/insert-only/);
  });

  it('exposes no way to edit a decision (OpenAPI)', () => {
    const api = JSON.parse(readFileSync('openapi/openapi.json', 'utf8'));
    expect(Object.keys(api.paths['/v1/stages/{id}/decision'])).toEqual(['get']);
  });

  it('hides the decision of an unpublished problem', async () => {
    const w = await world('Dark ring road lights');
    await db
      .update(s.problem)
      .set({ state: 'draft', publishedAt: null })
      .where(eq(s.problem.id, w.pid));
    await decision(w.stageId).expect(404);
  });
});
