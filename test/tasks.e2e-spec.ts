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
const example = (dir: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(EX, dir, 'examples', file), 'utf8'));

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
let pid: string;
let poster: Person;
let needsChoice: string; // stage that needs a choice
let direct: string; // stage that does not
type Person = { id: string; h: Record<string, string> };

const http = () => request(app.getHttpServer());
const person = async (role = 'member'): Promise<Person> => {
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
const taskBody = (stageRef: string) => ({
  content: {
    ...example('task', 'valid-survey-task.json'),
    stage_ref: stageRef,
  },
});
const note = (taskId: string) => ({
  content: {
    ...example('contribution.progress_update', 'valid-1.json'),
    task_ref: taskId,
  },
});
const mk = async (stageId: string, stageRef: string, by = poster) =>
  (
    await http()
      .post(`/v1/stages/${stageId}/tasks`)
      .set(by.h)
      .send(taskBody(stageRef))
      .expect(201)
  ).body as { id: string };
const submit = (stageId: string) =>
  http().post(`/v1/stages/${stageId}/submit`).set(poster.h);
const passedChoice = (stageId: string) =>
  db.insert(s.stageChoice).values({
    id: newId(),
    stageId,
    optionIds: [],
    steps: [{ s: 1 }],
    decisionMethod: 'poster_after_input',
    deciderId: poster.id,
    authority: 'plan',
    rationale: 'why',
    content: {},
    gateResult: { result: 'passed', layer: 'both' },
    createdAt: new Date(),
  });
const setStage = (id: string, state: string) =>
  db.update(s.stage).set({ state }).where(eq(s.stage.id, id));

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
  poster = await person();
  pid = await fx.problem('draft', { initiatorId: poster.id });
  const node = (name: string, needs: boolean) => ({
    name,
    label: name,
    goal: 'Know which poles are dark on the ring road.',
    needs_choice: needs,
    acceptance_criteria: [
      { statement: 'Every pole has a recorded status', measure: 'met_or_not' },
    ],
  });
  await app.get(STAGE_PLAN_REPO).savePlan(
    pid,
    planFromWire(
      [node('map_faults', true), node('log_work', false)],
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
  const rows = await db
    .select()
    .from(s.stage)
    .where(eq(s.stage.problemId, pid));
  needsChoice = rows.find((r) => r.name === 'map_faults')!.id;
  direct = rows.find((r) => r.name === 'log_work')!.id;
  await setStage(needsChoice, 'active');
  await setStage(direct, 'active');
});

afterAll(async () => {
  await app.close();
  config.policyPacksDir = saved.dir;
  config.policyActive = saved.active;
  const ids = [needsChoice, direct];
  const tasks = await db
    .select({ id: s.task.id })
    .from(s.task)
    .where(inArray(s.task.stageId, ids));
  if (tasks.length)
    await db.delete(s.taskBlocker).where(
      inArray(
        s.taskBlocker.taskId,
        tasks.map((t) => t.id),
      ),
    );
  await db.delete(s.task).where(inArray(s.task.stageId, ids));
  await db.delete(s.stageEvent).where(inArray(s.stageEvent.stageId, ids));
  await db.delete(s.stageChoice).where(inArray(s.stageChoice.stageId, ids));
  await db.delete(s.stageEvidence).where(inArray(s.stageEvidence.stageId, ids));
  await db.delete(s.contribution).where(eq(s.contribution.problemId, pid));
  await db
    .delete(s.acceptanceCriterion)
    .where(inArray(s.acceptanceCriterion.stageId, ids));
  await db
    .delete(s.acceptanceCriterion)
    .where(eq(s.acceptanceCriterion.problemId, pid));
  await db.delete(s.stage).where(inArray(s.stage.id, ids));
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

describe('creating tasks', () => {
  it('is refused before the choice gate passed, then allowed; a stage without a choice takes tasks directly', async () => {
    const r = await http()
      .post(`/v1/stages/${needsChoice}/tasks`)
      .set(poster.h)
      .send(taskBody('map_faults'))
      .expect(409);
    expect(r.body.error.code).toBe('choice_required');
    await db.insert(s.stageChoice).values({
      id: newId(),
      stageId: needsChoice,
      optionIds: [],
      steps: [{ s: 1 }],
      decisionMethod: 'poster_after_input',
      deciderId: poster.id,
      authority: 'plan',
      rationale: 'why',
      content: {},
      gateResult: { result: 'held' },
      createdAt: new Date(),
    });
    await http()
      .post(`/v1/stages/${needsChoice}/tasks`)
      .set(poster.h)
      .send(taskBody('map_faults'))
      .expect(409);
    await db
      .update(s.stageChoice)
      .set({ gateResult: { result: 'passed', layer: 'both' } })
      .where(eq(s.stageChoice.stageId, needsChoice));
    const t = await mk(needsChoice, 'map_faults');
    expect(t).toMatchObject({ status: 'open', verified: false });
    const direct1 = await mk(direct, 'log_work');
    expect(direct1.id).toBeTruthy();
  });

  it('is for the poster or a steward, names its own stage and follows the schema', async () => {
    const other = await person();
    await http()
      .post(`/v1/stages/${direct}/tasks`)
      .set(other.h)
      .send(taskBody('log_work'))
      .expect(403);
    await mk(direct, 'log_work', await person('moderator'));
    const wrong = await http()
      .post(`/v1/stages/${direct}/tasks`)
      .set(poster.h)
      .send(taskBody('map_faults'))
      .expect(400);
    expect(wrong.body.error.fieldErrors['/content/stage_ref']).toBeTruthy();
    await http()
      .post(`/v1/stages/${direct}/tasks`)
      .set(poster.h)
      .send({
        content: example('task', 'invalid-missing-deliverable.json'),
      })
      .expect(400);
    await http()
      .post(`/v1/stages/${direct}/tasks`)
      .send(taskBody('log_work'))
      .expect(401);
  });

  it('is public to read, with no email or account id anywhere', async () => {
    const r = await http().get(`/v1/stages/${direct}/tasks`).expect(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(Object.keys(r.body.items[0]).sort()).toEqual([
      'assigneeHandle',
      'blockers',
      'content',
      'createdAt',
      'droppedReason',
      'id',
      'required',
      'stageId',
      'status',
      'title',
      'updatedAt',
      'verificationNote',
      'verified',
    ]);
    expect(
      JSON.stringify(
        r.body.items.map((t: { content: unknown }) => ({ ...t, content: 0 })),
      ),
    ).not.toMatch(/email|owner|initiator/i);
    const ws = await http().get(`/v1/stages/${direct}`).expect(200);
    expect(ws.body.tasks.length).toBe(r.body.items.length);
  });
});

describe('claim, progress and verification', () => {
  it('has one winner when two people claim at once, and the loser spends no reply', async () => {
    const t = await mk(direct, 'log_work');
    const [a, b] = [await person(), await person()];
    const res = await Promise.all(
      [a, b].map((p) =>
        http().post(`/v1/tasks/${t.id}/claim`).set(p.h).send(note(t.id)),
      ),
    );
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = res.findIndex((r) => r.status === 409);
    expect(res[loser]!.body.error.code).toBe('task_taken');
    const winner = res[1 - loser]!.body;
    expect(winner.status).toBe('claimed');
    const cs = await db
      .select()
      .from(s.contribution)
      .where(eq(s.contribution.authorId, [a, b][loser]!.id));
    expect(cs).toHaveLength(0);
  });

  it('claims must name the task', async () => {
    const t = await mk(direct, 'log_work');
    const p = await person();
    const r = await http()
      .post(`/v1/tasks/${t.id}/claim`)
      .set(p.h)
      .send(note(newId()))
      .expect(400);
    expect(r.body.error.fieldErrors['/content/task_ref']).toBeTruthy();
  });

  it('counts claims and notes toward the D-85 cap (4 per problem per day), without a cooldown', async () => {
    const t = await mk(direct, 'log_work');
    const p = await person();
    await http()
      .post(`/v1/tasks/${t.id}/claim`)
      .set(p.h)
      .send(note(t.id))
      .expect(201);
    for (let i = 0; i < 3; i++) {
      const r = await http()
        .post(`/v1/tasks/${t.id}/progress`)
        .set(p.h)
        .send(note(t.id))
        .expect(201);
      expect(r.body.status).toBe('in_progress');
    }
    const over = await http()
      .post(`/v1/tasks/${t.id}/progress`)
      .set(p.h)
      .send(note(t.id))
      .expect(429);
    expect(over.body.error.code).toBe('reply_limit_reached');
    const mine = await db
      .select()
      .from(s.contribution)
      .where(eq(s.contribution.authorId, p.id));
    expect(mine).toHaveLength(4);
    expect(mine.every((c) => c.type === 'progress_update')).toBe(true);
    // creating tasks is not a reply: the poster has made many and still has a full allowance
    const a = await http()
      .get(`/v1/me/problems/${pid}/reply-allowance`)
      .set(poster.h)
      .expect(200);
    expect(a.body.remaining).toBe(a.body.limit);
  });

  it('only the doer reports progress; the doer cannot verify; someone else can, once done', async () => {
    const t = await mk(direct, 'log_work');
    const [doer, other] = [await person(), await person()];
    await http()
      .post(`/v1/tasks/${t.id}/claim`)
      .set(doer.h)
      .send(note(t.id))
      .expect(201);
    await http()
      .post(`/v1/tasks/${t.id}/progress`)
      .set(other.h)
      .send(note(t.id))
      .expect(403);
    const verify = { verificationNote: 'Checked the sheet against the poles.' };
    await http()
      .patch(`/v1/tasks/${t.id}`)
      .set(other.h)
      .send(verify)
      .expect(409);
    // a bystander cannot move it on
    await http()
      .patch(`/v1/tasks/${t.id}`)
      .set(other.h)
      .send({ status: 'done' })
      .expect(403);
    await http()
      .patch(`/v1/tasks/${t.id}`)
      .set(doer.h)
      .send({ status: 'done' })
      .expect(200);
    const own = await http()
      .patch(`/v1/tasks/${t.id}`)
      .set(doer.h)
      .send(verify)
      .expect(403);
    expect(own.body.error.code).toBe('cannot_verify_own');
    const ok = await http()
      .patch(`/v1/tasks/${t.id}`)
      .set(other.h)
      .send(verify)
      .expect(200);
    expect(ok.body).toMatchObject({ status: 'done', verified: true });
    // done is final
    await http()
      .patch(`/v1/tasks/${t.id}`)
      .set(doer.h)
      .send({ status: 'dropped', droppedReason: 'changed my mind' })
      .expect(409);
  });

  it('dropping needs a reason', async () => {
    const t = await mk(direct, 'log_work');
    const r = await http()
      .patch(`/v1/tasks/${t.id}`)
      .set(poster.h)
      .send({ status: 'dropped' })
      .expect(400);
    expect(r.body.error.fieldErrors['/droppedReason']).toBeTruthy();
    const ok = await http()
      .patch(`/v1/tasks/${t.id}`)
      .set(poster.h)
      .send({
        status: 'dropped',
        droppedReason: 'The council already did this.',
      })
      .expect(200);
    expect(ok.body).toMatchObject({
      status: 'dropped',
      droppedReason: 'The council already did this.',
    });
    await http()
      .post(`/v1/tasks/${t.id}/claim`)
      .set((await person()).h)
      .send(note(t.id))
      .expect(409);
  });
});

describe('blockers', () => {
  it('are added and cleared by the doer, poster or a steward only', async () => {
    const t = await mk(direct, 'log_work');
    const [doer, other] = [await person(), await person()];
    await http()
      .post(`/v1/tasks/${t.id}/claim`)
      .set(doer.h)
      .send(note(t.id))
      .expect(201);
    await http()
      .post(`/v1/tasks/${t.id}/blockers`)
      .set(other.h)
      .send({ text: 'Pole numbers are not posted.' })
      .expect(403);
    const added = await http()
      .post(`/v1/tasks/${t.id}/blockers`)
      .set(doer.h)
      .send({ text: 'Pole numbers are not posted.' })
      .expect(201);
    const [b] = added.body.blockers;
    expect(b).toMatchObject({ cleared: false });
    await http()
      .patch(`/v1/tasks/${t.id}/blockers/${b.id}`)
      .set(other.h)
      .send({})
      .expect(403);
    const cleared = await http()
      .patch(`/v1/tasks/${t.id}/blockers/${b.id}`)
      .set(poster.h)
      .send({ note: 'The council posted them.' })
      .expect(200);
    expect(cleared.body.blockers[0]).toMatchObject({
      cleared: true,
      clearedNote: 'The council posted them.',
    });
    await http()
      .patch(`/v1/tasks/${t.id}/blockers/${b.id}`)
      .set(poster.h)
      .send({})
      .expect(409);
    await http()
      .post(`/v1/tasks/${t.id}/blockers`)
      .set(doer.h)
      .send({ text: 'no' })
      .expect(400);
  });
});

describe('ST04 gate', () => {
  it('names open required tasks, then allows submit once each is done or dropped with a reason', async () => {
    // a fresh problem: a one-stage plan with a passed choice and mapped evidence, so only tasks can block
    const p2 = await fx.problem('draft', { initiatorId: poster.id });
    await app.get(STAGE_PLAN_REPO).savePlan(
      p2,
      planFromWire(
        [
          {
            name: 'gate_stage',
            label: 'Gate',
            goal: 'Know which poles are dark.',
            acceptance_criteria: [
              { statement: 'Every pole has a status', measure: 'met_or_not' },
            ],
          },
        ],
        [{ statement: 'The ring road stays lit.', how_observed: 'Fault log.' }],
      ),
    );
    await db
      .update(s.problem)
      .set({ state: 'active', publishedAt: new Date() })
      .where(eq(s.problem.id, p2));
    const [st] = await db
      .select()
      .from(s.stage)
      .where(eq(s.stage.problemId, p2));
    const sid = st!.id;
    try {
      await setStage(sid, 'active');
      await passedChoice(sid);
      const [crit] = await db
        .select()
        .from(s.acceptanceCriterion)
        .where(eq(s.acceptanceCriterion.stageId, sid));
      await db.insert(s.stageEvidence).values({
        id: newId(),
        stageId: sid,
        url: 'https://example.org/e',
        claimText: 'claim',
        criteriaIds: [crit!.id],
        submittedBy: poster.id,
        content: {},
        createdAt: new Date(),
      });
      const a = await mk(sid, 'gate_stage');
      const b = await mk(sid, 'gate_stage');
      const miss = await submit(sid).expect(400);
      expect(miss.body.error.fieldErrors).toMatchObject({
        tasks: 'required',
        [`/tasks/${a.id}`]: expect.stringContaining('open'),
        [`/tasks/${b.id}`]: expect.stringContaining('open'),
      });
      expect(miss.body.error.fieldErrors.choice).toBeUndefined();
      const doer = await person();
      await http()
        .post(`/v1/tasks/${a.id}/claim`)
        .set(doer.h)
        .send(note(a.id))
        .expect(201);
      await http()
        .patch(`/v1/tasks/${a.id}`)
        .set(doer.h)
        .send({ status: 'done' })
        .expect(200);
      const still = await submit(sid).expect(400);
      expect(Object.keys(still.body.error.fieldErrors)).toContain(
        `/tasks/${b.id}`,
      );
      expect(Object.keys(still.body.error.fieldErrors)).not.toContain(
        `/tasks/${a.id}`,
      );
      await http()
        .patch(`/v1/tasks/${b.id}`)
        .set(poster.h)
        .send({ status: 'dropped', droppedReason: 'Not needed any more.' })
        .expect(200);
      const ok = await submit(sid).expect(200);
      expect(ok.body.state).toBe('resolving');
      // a resolving stage takes no new tasks and no task changes
      await http()
        .post(`/v1/stages/${sid}/tasks`)
        .set(poster.h)
        .send(taskBody('gate_stage'))
        .expect(409);
      await http()
        .patch(`/v1/tasks/${a.id}`)
        .set((await person()).h)
        .send({ verificationNote: 'Looks right to me.' })
        .expect(409);
    } finally {
      const ts = await db
        .select({ id: s.task.id })
        .from(s.task)
        .where(eq(s.task.stageId, sid));
      if (ts.length)
        await db.delete(s.taskBlocker).where(
          inArray(
            s.taskBlocker.taskId,
            ts.map((t) => t.id),
          ),
        );
      await db.delete(s.task).where(eq(s.task.stageId, sid));
      await db.delete(s.stageEvent).where(eq(s.stageEvent.stageId, sid));
      await db.delete(s.stageChoice).where(eq(s.stageChoice.stageId, sid));
      await db.delete(s.stageEvidence).where(eq(s.stageEvidence.stageId, sid));
      await db.delete(s.contribution).where(eq(s.contribution.problemId, p2));
      await db
        .delete(s.acceptanceCriterion)
        .where(eq(s.acceptanceCriterion.stageId, sid));
      await db
        .delete(s.acceptanceCriterion)
        .where(eq(s.acceptanceCriterion.problemId, p2));
      await db.delete(s.stage).where(eq(s.stage.id, sid));
    }
  });

  it('refuses task changes while the stage is blocked or resolving only where stated, and new tasks unless active', async () => {
    await setStage(direct, 'blocked');
    try {
      await http()
        .post(`/v1/stages/${direct}/tasks`)
        .set(poster.h)
        .send(taskBody('log_work'))
        .expect(409);
    } finally {
      await setStage(direct, 'active');
    }
  });
});
