import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken, newToken } from '../src/accounts/infra/crypto.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { config } from '../src/config.js';
import * as s from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { ID_GENERATOR } from '../src/platform/ports.js';
import { TransitionEngine } from '../src/problems/app/transition-engine.js';
import { TransitionEffects } from '../src/problems/app/transition-ports.js';
import {
  planFromWire,
  type WireStageNode,
} from '../src/stages/app/plan-wire.js';
import { StageEngine } from '../src/stages/app/stage-engine.js';
import { STAGE_PLAN_REPO } from '../src/stages/app/stage-plan.repository.js';
import { STAGE_TRANSITIONS } from '../src/stages/domain/transitions.js';
import { ProblemFixtures } from './support/problems.js';

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
let engine: StageEngine;
const tokens: Record<string, string> = {};
let poster: string;
let bob: string;

const http = () => request(app.getHttpServer());
const as = (a: string) => ({ Authorization: `Bearer ${tokens[a]}` });
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

const node = (
  name: string,
  over: Partial<WireStageNode> = {},
): WireStageNode => ({
  name,
  goal: `Goal of ${name} in the plan.`,
  acceptance_criteria: [
    { statement: `${name} is done`, measure: 'met_or_not' },
  ],
  ...over,
});

/** A published, active problem with the given plan; `states` overrides stage states by plan name. */
async function mk(
  nodes: WireStageNode[],
  states: Record<string, string> = {},
  problemState = 'active',
) {
  const pid = await fx.problem('draft', { initiatorId: poster });
  await app
    .get(STAGE_PLAN_REPO)
    .savePlan(
      pid,
      planFromWire(nodes, [
        { statement: 'The road is lit.', how_observed: 'Log.' },
      ]),
    );
  await db
    .update(s.problem)
    .set({ state: problemState, publishedAt: new Date() })
    .where(eq(s.problem.id, pid));
  const ids: Record<string, string> = {};
  for (const r of await db
    .select()
    .from(s.stage)
    .where(eq(s.stage.problemId, pid))) {
    ids[r.name] = r.id;
    await db
      .update(s.stage)
      .set({ state: states[r.name] ?? 'planned' })
      .where(eq(s.stage.id, r.id));
  }
  return { pid, ids };
}

const run = { kind: 'run' as const, id: null };
const RESULT = {
  ruleIds: ['R1'],
  criterionResults: [{ ref: 1, met: true }],
  policyVersion: 'v1',
};
const resolve = async (id: string) => {
  await db
    .update(s.stage)
    .set({ state: 'resolving' })
    .where(eq(s.stage.id, id));
  return engine.apply({
    stageId: id,
    to: 'resolved',
    actor: run,
    runId: newId(),
    fields: RESULT,
  });
};
const stateOf = async (id: string) =>
  (await db.select().from(s.stage).where(eq(s.stage.id, id)))[0].state;
const sevents = (id: string) =>
  db
    .select()
    .from(s.stageEvent)
    .where(eq(s.stageEvent.stageId, id))
    .orderBy(asc(s.stageEvent.occurredAt), asc(s.stageEvent.id));
const pevents = async (pid: string, type: string) =>
  (
    await db
      .select()
      .from(s.problemEvent)
      .where(eq(s.problemEvent.problemId, pid))
  ).filter((e) => e.type === type);
const prow = async (pid: string) =>
  (await db.select().from(s.problem).where(eq(s.problem.id, pid)))[0];
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => (e as { code: string }).code,
  );

const BLOCK = {
  blocker: 'The council road order bans works until the survey ends.',
  source: 'Council road order 12',
  sourceVersion: '2026-02',
  blockedActions: ['dig the verge'],
  recheckCondition: 'The survey ends',
  nextRoute: 'Ask the roads officer for a works permit.',
  attempts: ['Emailed the roads officer on 3 March'],
};

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
  engine = app.get(StageEngine);
  poster = await signedIn();
  bob = await signedIn();
});

afterAll(async () => {
  await app.close();
  const st = (
    await db
      .select({ id: s.stage.id })
      .from(s.stage)
      .where(inArray(s.stage.problemId, fx.problems))
  ).map((r) => r.id);
  if (st.length) {
    await db.delete(s.stageEvent).where(inArray(s.stageEvent.stageId, st));
    await db
      .delete(s.stageEvidence)
      .where(inArray(s.stageEvidence.stageId, st));
    await db.delete(s.stageChoice).where(inArray(s.stageChoice.stageId, st));
    await db
      .delete(s.acceptanceCriterion)
      .where(inArray(s.acceptanceCriterion.stageId, st));
    await db.delete(s.stageEdge).where(inArray(s.stageEdge.stageId, st));
  }
  await db
    .delete(s.acceptanceCriterion)
    .where(inArray(s.acceptanceCriterion.problemId, fx.problems));
  if (st.length) await db.delete(s.stage).where(inArray(s.stage.id, st));
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

const DIAMOND = [
  node('a', { auto_start: true }),
  node('b', { depends_on: ['a'] }),
  node('c', { depends_on: ['a'] }),
  node('d', { depends_on: ['b', 'c'] }),
];

describe('gating', () => {
  it.each([
    ['b first', ['b', 'c']],
    ['c first', ['c', 'b']],
  ])(
    'a diamond resolves with %s and asks for the final check once',
    async (_n, order) => {
      const { pid, ids } = await mk(DIAMOND, { a: 'active' });
      await resolve(ids.a);
      expect(await stateOf(ids.b)).toBe('active');
      expect(await stateOf(ids.c)).toBe('active');
      expect(await stateOf(ids.d)).toBe('planned');
      await resolve(ids[order[0]]);
      expect(await stateOf(ids.d)).toBe('planned');
      await resolve(ids[order[1]]);
      expect(await stateOf(ids.d)).toBe('active');
      await resolve(ids.d);
      const p = await prow(pid);
      expect(p.pendingTransition).toMatchObject({
        transitionId: 'T15',
        to: 'solved',
        proposedBy: ['system'],
      });
      expect(
        (p.pendingTransition as { fields: { criteriaEvidence: unknown[] } })
          .fields.criteriaEvidence,
      ).toHaveLength(1);
      expect(await pevents(pid, 'transition_proposed')).toHaveLength(1);
      expect(p.state).toBe('active');
    },
  );

  it('makes a successor ready exactly once when its predecessors resolve in parallel (20 runs)', async () => {
    for (let n = 0; n < 20; n++) {
      const { ids } = await mk(
        [
          node('x'),
          node('y'),
          node('z', { depends_on: ['x', 'y'], auto_start: false }),
        ],
        { x: 'resolving', y: 'resolving' },
      );
      await Promise.all(
        [ids.x, ids.y].map((id) =>
          engine.apply({
            stageId: id,
            to: 'resolved',
            actor: run,
            runId: newId(),
            fields: RESULT,
          }),
        ),
      );
      const ev = (await sevents(ids.z)).filter((e) => e.toState === 'ready');
      expect(ev).toHaveLength(1);
      expect(await stateOf(ids.z)).toBe('ready');
    }
  });

  it('keeps a stage with auto_start false ready and lets the steward start it', async () => {
    const { ids } = await mk([node('a', { auto_start: false })], {
      a: 'ready',
    });
    await http().post(`/v1/stages/${ids.a}/start`).expect(401);
    await http().post(`/v1/stages/${ids.a}/start`).set(as(bob)).expect(403);
    const r = await http()
      .post(`/v1/stages/${ids.a}/start`)
      .set(as(poster))
      .expect(200);
    expect(r.body).toMatchObject({ state: 'active', chip: 'In progress' });
  });

  it('refuses start from planned with not_ready', async () => {
    const { ids } = await mk([node('a'), node('b', { depends_on: ['a'] })], {
      a: 'active',
    });
    const r = await http()
      .post(`/v1/stages/${ids.b}/start`)
      .set(as(poster))
      .expect(409);
    expect(r.body.error.code).toBe('not_ready');
  });

  it('refuses start and submit while the problem is paused', async () => {
    const { ids } = await mk(
      [node('a', { auto_start: false }), node('b')],
      { a: 'ready', b: 'active' },
      'paused',
    );
    for (const [id, op] of [
      [ids.a, 'start'],
      [ids.b, 'submit'],
    ]) {
      const r = await http()
        .post(`/v1/stages/${id}/${op}`)
        .set(as(poster))
        .expect(409);
      expect(r.body.error.code).toBe('problem_not_active');
    }
  });
});

describe('submit', () => {
  it('names what is missing, then freezes the evidence and queues the resolution', async () => {
    const { ids } = await mk([node('a')], { a: 'active' });
    const miss = await http()
      .post(`/v1/stages/${ids.a}/submit`)
      .set(as(poster))
      .expect(400);
    expect(miss.body.error.fieldErrors).toEqual({
      choice: 'required',
      evidence: 'required',
    });
    const [crit] = await db
      .select()
      .from(s.acceptanceCriterion)
      .where(eq(s.acceptanceCriterion.stageId, ids.a));
    await db.insert(s.stageChoice).values({
      id: newId(),
      stageId: ids.a,
      optionIds: [],
      steps: [{ s: 1 }],
      decisionMethod: 'poster_after_input',
      deciderId: poster,
      authority: 'plan',
      rationale: 'why',
      content: {},
      gateResult: { result: 'passed', layer: 'both' },
      createdAt: new Date(),
    });
    const ev = newId();
    await db.insert(s.stageEvidence).values({
      id: ev,
      stageId: ids.a,
      url: 'https://example.org/e',
      claimText: 'claim',
      criteriaIds: [crit.id],
      submittedBy: poster,
      content: {},
      createdAt: new Date(),
    });
    const ok = await http()
      .post(`/v1/stages/${ids.a}/submit`)
      .set(as(poster))
      .expect(200);
    expect(ok.body).toMatchObject({
      state: 'resolving',
      chip: 'Checking evidence',
    });
    const [row] = await db
      .select()
      .from(s.stageEvidence)
      .where(eq(s.stageEvidence.id, ev));
    expect(row.frozenAt).not.toBeNull();
    expect((await sevents(ids.a)).map((e) => e.type)).toContain(
      'resolution_queued',
    );
    // not twice
    await http().post(`/v1/stages/${ids.a}/submit`).set(as(poster)).expect(409);
  });

  it('does not count a choice whose gate did not pass', async () => {
    const { ids } = await mk([node('a')], { a: 'active' });
    await db.insert(s.stageChoice).values({
      id: newId(),
      stageId: ids.a,
      optionIds: [],
      steps: [{ s: 1 }],
      decisionMethod: 'poster_after_input',
      deciderId: poster,
      authority: 'plan',
      rationale: 'why',
      content: {},
      gateResult: { result: 'held' },
      createdAt: new Date(),
    });
    const r = await http()
      .post(`/v1/stages/${ids.a}/submit`)
      .set(as(poster))
      .expect(400);
    expect(r.body.error.fieldErrors.choice).toBe('required');
  });
});

describe('blocks', () => {
  it('stops one branch only, queues the stuck candidate once, and resumes in the prior state', async () => {
    const { pid, ids } = await mk(
      [node('p'), node('q'), node('r', { depends_on: ['p', 'q'] })],
      { p: 'active', q: 'active' },
    );
    await http()
      .post(`/v1/stages/${ids.p}/block`)
      .set(as(poster))
      .send({ ...BLOCK, attempts: [] })
      .expect(400);
    await http()
      .post(`/v1/stages/${ids.p}/block`)
      .set(as(poster))
      .send(BLOCK)
      .expect(200);
    expect(await stateOf(ids.p)).toBe('blocked');
    expect(await stateOf(ids.q)).toBe('active');
    expect(await pevents(pid, 'problem.stuck_candidate')).toHaveLength(0);
    const ev = (await sevents(ids.p)).find((e) => e.toState === 'blocked')!;
    expect(ev.payload).toMatchObject({
      transitionId: 'ST07',
      blocker: { source: BLOCK.source },
    });
    await http()
      .post(`/v1/stages/${ids.q}/block`)
      .set(as(poster))
      .send(BLOCK)
      .expect(200);
    expect(await pevents(pid, 'problem.stuck_candidate')).toHaveLength(1);
    expect((await prow(pid)).state).toBe('active'); // the run decides T13, never this engine
    await http()
      .post(`/v1/stages/${ids.p}/unblock`)
      .set(as(poster))
      .send({ clearedNote: 'Permit granted.' })
      .expect(400);
    const u = await http()
      .post(`/v1/stages/${ids.p}/unblock`)
      .set(as(poster))
      .send({
        clearedNote: 'Permit granted.',
        evidence: ['https://example.org/permit'],
      })
      .expect(200);
    expect(u.body.state).toBe('active');
    expect(await pevents(pid, 'problem.stuck_candidate')).toHaveLength(1);
  });

  it('proposes T14 first when the problem is stuck and leaves the stage blocked', async () => {
    const { pid, ids } = await mk([node('p')], { p: 'blocked' }, 'stuck');
    await db
      .update(s.stage)
      .set({ resumeState: 'active' })
      .where(eq(s.stage.id, ids.p));
    const r = await http()
      .post(`/v1/stages/${ids.p}/unblock`)
      .set(as(poster))
      .send({ clearedNote: 'Cleared.', evidence: ['https://example.org/x'] })
      .expect(409);
    expect(r.body.error.code).toBe('problem_not_active');
    expect(await stateOf(ids.p)).toBe('blocked');
    expect((await prow(pid)).pendingTransition).toMatchObject({
      transitionId: 'T14',
    });
  });
});

describe('closure and rollback', () => {
  it('skips every unresolved stage when the problem closes', async () => {
    const { pid, ids } = await mk(
      [node('a'), node('b', { depends_on: ['a'] }), node('c'), node('d')],
      { a: 'active', c: 'resolving', d: 'blocked' },
    );
    await db
      .update(s.stage)
      .set({ state: 'resolved' })
      .where(eq(s.stage.id, ids.d));
    await app.get(TransitionEngine).apply({
      problemId: pid,
      to: 'closed',
      actor: run,
      runId: newId(),
      fields: { reasonCode: 'duplicate', explanation: 'x' },
    });
    expect((await prow(pid)).state).toBe('closed');
    expect(await stateOf(ids.a)).toBe('skipped');
    expect(await stateOf(ids.b)).toBe('skipped');
    expect(await stateOf(ids.c)).toBe('skipped');
    expect(await stateOf(ids.d)).toBe('resolved');
    expect((await sevents(ids.a)).at(-1)).toMatchObject({
      toState: 'skipped',
      reason: 'closed: duplicate',
    });
  });

  it('rolls everything back when an effect throws', async () => {
    const { pid, ids } = await mk([node('a'), node('b')], {
      a: 'active',
      b: 'planned',
    });
    let boom = true;
    app.get(TransitionEffects).register({
      on: ['T16'],
      run: async () => {
        if (boom) throw new Error('boom');
      },
    });
    await expect(
      app.get(TransitionEngine).apply({
        problemId: pid,
        to: 'closed',
        actor: run,
        runId: newId(),
        fields: { reasonCode: 'duplicate', explanation: 'x' },
      }),
    ).rejects.toThrow('boom');
    boom = false;
    expect((await prow(pid)).state).toBe('active');
    expect(await stateOf(ids.a)).toBe('active');
    expect(await sevents(ids.a)).toHaveLength(0);
  });

  it('rolls the stage back when an event insert fails mid-gate', async () => {
    const { ids } = await mk([node('a'), node('b', { depends_on: ['a'] })], {
      a: 'resolving',
    });
    const gen = app.get<{ next(): string }>(ID_GENERATOR);
    const spy = vi.spyOn(gen, 'next');
    let n = 0;
    spy.mockImplementation(() => {
      if (++n === 2) throw new Error('event insert failed');
      return newId();
    });
    await expect(resolve(ids.a)).rejects.toThrow('event insert failed');
    spy.mockRestore();
    expect(await stateOf(ids.a)).toBe('resolving');
    expect(await stateOf(ids.b)).toBe('planned');
    expect(await sevents(ids.b)).toHaveLength(0);
  });
});

describe('allowedStageTransitions', () => {
  it('matches the domain table for steward, member and guest', async () => {
    const { ids } = await mk([node('a')], { a: 'active' });
    const stewardRows = STAGE_TRANSITIONS.filter(
      (t) => t.from.includes('active') && t.actors.includes('steward'),
    ).map((t) => ({ to: t.to, requires: [...t.required], mode: 'direct' }));
    expect(stewardRows.map((r) => r.to).sort()).toEqual([
      'blocked',
      'resolving',
    ]);
    const get = (who?: string) => {
      const r = http().get(`/v1/stages/${ids.a}`);
      return (who ? r.set(as(who)) : r).expect(200);
    };
    expect((await get(poster)).body.allowedStageTransitions).toEqual(
      stewardRows,
    );
    expect((await get(bob)).body.allowedStageTransitions).toEqual([]);
    expect((await get()).body.allowedStageTransitions).toEqual([]);
    const map = await http()
      .get(
        `/v1/stages/by-problem/${(await db.select().from(s.stage).where(eq(s.stage.id, ids.a)))[0].problemId}`,
      )
      .set(as(poster))
      .expect(200);
    expect(map.body.stages[0].allowedStageTransitions).toEqual(stewardRows);
  });
});
