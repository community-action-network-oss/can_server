import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { mkdtempSync, readFileSync } from 'node:fs';
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
import { seedStageFixture } from '../src/seed/stage-fixtures.js';
import { cpSync } from 'node:fs';
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
let pids: string[]; // fixture problems 1..4

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
const stageOf = async (pid: string, name: string) =>
  (
    await db
      .select()
      .from(s.stage)
      .where(and(eq(s.stage.problemId, pid), eq(s.stage.name, name)))
  )[0];
let n = 0;
async function evidenceContribution(
  pid: string,
  stageId: string | null,
  o: { status?: string; type?: string } = {},
) {
  const id = newId();
  await db.insert(s.contribution).values({
    id,
    problemId: pid,
    stageId,
    forLaterStage: !!stageId,
    authorId: bob,
    type: o.type ?? 'evidence',
    body: { claim: 'The repair log shows the feed was fixed.' },
    status: o.status ?? 'accepted',
    createdAt: new Date(Date.now() - 60_000 + n++),
    originNodeId: config.nodeId,
    protocolVersion: '1',
  });
  await db.insert(s.evidenceRef).values({
    id: newId(),
    contributionId: id,
    url: `https://example.org/log/${id}`,
    note: 'Council log entry.',
    addedAt: new Date(),
  });
  return id;
}
const contributionCount = async (pid: string) =>
  Number(
    (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(s.contribution)
        .where(eq(s.contribution.problemId, pid))
    )[0].n,
  );

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stage-ahead-'));
  cpSync(FIXTURE_DIR, tmp, { recursive: true });
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
  const pub = { publishedAt: new Date('2026-03-01T09:00:00Z') };
  pids = [
    await fx.problem('active', { ...pub, initiatorId: poster }),
    await fx.problem('active', pub),
    await fx.problem('stuck', pub),
    await fx.problem('solved', pub),
  ];
  await seedStageFixture(pool, { problemIds: pids, authorId: bob });
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
    await db.delete(s.stageEdge).where(inArray(s.stageEdge.stageId, st));
    await db
      .delete(s.acceptanceCriterion)
      .where(inArray(s.acceptanceCriterion.stageId, st));
  }
  await db
    .delete(s.acceptanceCriterion)
    .where(inArray(s.acceptanceCriterion.problemId, fx.problems));
  const cs = (
    await db
      .select({ id: s.contribution.id })
      .from(s.contribution)
      .where(inArray(s.contribution.problemId, fx.problems))
  ).map((c) => c.id);
  if (cs.length) {
    await db
      .delete(s.evidenceRef)
      .where(inArray(s.evidenceRef.contributionId, cs));
    await db.delete(s.contribution).where(inArray(s.contribution.id, cs));
  }
  if (st.length) await db.delete(s.stage).where(inArray(s.stage.id, st));
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

describe('GET /v1/stage-templates', () => {
  it('equals the 01b classic-5 table and the one-stage rule', async () => {
    const md = readFileSync(
      join(process.cwd(), '../docs/spec/01b-stages.md'),
      'utf8',
    );
    const rows = md
      .split('### The `classic-5` template')[1]
      .split('A poster may instead')[0]
      .split('\n')
      .filter((l) => /^\| `/.test(l))
      .map((l) => l.split('|').map((c) => c.trim()))
      .map(([, stage, deps, choice, crit]) => ({
        name: stage.match(/`(\w+)`/)![1],
        label: stage.match(/\((.+)\)/)![1],
        dependsOn:
          deps === 'none'
            ? []
            : [...deps.matchAll(/`(\w+)`/g)].map((m) => m[1]),
        needsChoice: choice === 'true',
        statement: crit,
      }));
    expect(rows).toHaveLength(5);
    const r = await http().get('/v1/stage-templates').expect(200);
    const [classic, one] = r.body.items;
    expect(r.body.items.map((t: { id: string }) => t.id)).toEqual([
      'classic-5',
      'one-stage',
    ]);
    expect(
      classic.stages.map(
        (st: {
          name: string;
          label: string;
          dependsOn: string[];
          needsChoice: boolean;
          decisionMethod: string;
          criteria: { statement: string }[];
        }) => ({
          name: st.name,
          label: st.label,
          dependsOn: st.dependsOn,
          needsChoice: st.needsChoice,
          statement: st.criteria[0].statement,
        }),
      ),
    ).toEqual(rows);
    expect(classic.stages[0].decisionMethod).toBe('poster_after_input');
    expect(one.stages).toHaveLength(1);
    expect(one.stages[0].name).toBe('resolve');
    expect(one.stages[0].criteria).toEqual(one.finalCriteria);
  });
});

describe('stage fixture', () => {
  it('seeds twice with identical ids and the map shows the expected chips', async () => {
    const ids = async () =>
      (
        await db
          .select({ id: s.stage.id })
          .from(s.stage)
          .where(inArray(s.stage.problemId, pids))
      )
        .map((r) => r.id)
        .sort();
    const before = await ids();
    expect(before).toHaveLength(3 + 5 + 3 + 1);
    await seedStageFixture(pool, { problemIds: pids, authorId: bob });
    expect(await ids()).toEqual(before);
    const chips = async (pid: string) =>
      (
        await http().get(`/v1/stages/by-problem/${pid}`).expect(200)
      ).body.stages.map((x: { chip: string }) => x.chip);
    expect(await chips(pids[0])).toEqual(['Done', 'In progress', 'Planned']);
    expect(await chips(pids[1])).toEqual([
      'In progress',
      'Planned',
      'Planned',
      'Planned',
      'Planned',
    ]);
    expect((await chips(pids[2])).sort()).toEqual([
      'Blocked',
      'Done',
      'Planned',
    ]);
    expect(await chips(pids[3])).toEqual(['Done']);
    const ahead = await db
      .select()
      .from(s.contribution)
      .where(eq(s.contribution.problemId, pids[0]));
    expect(ahead).toHaveLength(1);
    expect(ahead[0].forLaterStage).toBe(true);
  });
});

describe('POST /v1/stages/{id}/attach-contribution', () => {
  const attach = (stageId: string, body: object, who = poster) =>
    http()
      .post(`/v1/stages/${stageId}/attach-contribution`)
      .set(as(who))
      .send(body);

  it('maps an accepted ahead contribution to evidence, links it and adds no reply', async () => {
    const repair = await stageOf(pids[0], 'repair');
    const c = await evidenceContribution(pids[0], repair.id);
    const before = await contributionCount(pids[0]);
    const r = await attach(repair.id, {
      contributionId: c,
      criterionRefs: [1],
    }).expect(201);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].criterionRefs).toEqual([1]);
    expect(await contributionCount(pids[0])).toBe(before);
    const [row] = await db
      .select()
      .from(s.stageEvidence)
      .where(eq(s.stageEvidence.id, r.body.items[0].id));
    expect(row.content).toMatchObject({ contribution_id: c });
    expect(typeof row.content.attached_at).toBe('string');
    const w = await http().get(`/v1/stages/${repair.id}`).expect(200);
    expect(w.body.evidence.map((e: { id: string }) => e.id)).toContain(
      r.body.items[0].id,
    );
    await attach(repair.id, { contributionId: c, criterionRefs: [1] }).expect(
      409,
    );
  });

  it('re-links a problem-level evidence contribution to the stage', async () => {
    const repair = await stageOf(pids[0], 'repair');
    const c = await evidenceContribution(pids[0], null, {});
    await attach(repair.id, { contributionId: c, criterionRefs: [1] }).expect(
      201,
    );
    const [row] = await db
      .select()
      .from(s.contribution)
      .where(eq(s.contribution.id, c));
    expect(row.stageId).toBe(repair.id);
  });

  it('refuses pending, hidden, wrong-type, other-stage and bad-criterion cases', async () => {
    const repair = await stageOf(pids[0], 'repair');
    const check = await stageOf(pids[0], 'check');
    for (const status of ['pending_review', 'hidden', 'tombstoned']) {
      const c = await evidenceContribution(pids[0], repair.id, { status });
      const r = await attach(repair.id, {
        contributionId: c,
        criterionRefs: [1],
      }).expect(409);
      expect(r.body.error?.code ?? r.body.code).toBe(
        'contribution_not_accepted',
      );
    }
    const obs = await evidenceContribution(pids[0], repair.id, {
      type: 'observation',
    });
    await attach(repair.id, { contributionId: obs, criterionRefs: [1] }).expect(
      409,
    );
    const other = await evidenceContribution(pids[0], check.id);
    await attach(repair.id, {
      contributionId: other,
      criterionRefs: [1],
    }).expect(409);
    const ok = await evidenceContribution(pids[0], repair.id);
    await attach(repair.id, { contributionId: ok, criterionRefs: [9] }).expect(
      400,
    );
    await attach(repair.id, { contributionId: ok, criterionRefs: [] }).expect(
      400,
    );
    await attach(repair.id, {
      contributionId: newId(),
      criterionRefs: [1],
    }).expect(404);
    await attach(
      repair.id,
      { contributionId: ok, criterionRefs: [1] },
      bob,
    ).expect(403);
    await http()
      .post(`/v1/stages/${repair.id}/attach-contribution`)
      .send({ contributionId: ok, criterionRefs: [1] })
      .expect(401);
  });

  it('a planned stage refuses attach and a contribution made ahead is not evidence', async () => {
    const check = await stageOf(pids[0], 'check');
    const c = await evidenceContribution(pids[0], check.id);
    const r = await attach(check.id, {
      contributionId: c,
      criterionRefs: [1],
    }).expect(409);
    expect(r.body.error?.code ?? r.body.code).toBe('not_ready');
    const w = await http().get(`/v1/stages/${check.id}`).expect(200);
    expect(w.body.evidence).toEqual([]);
  });

  it('works on a blocked stage', async () => {
    const reply = await stageOf(pids[2], 'reply');
    await db
      .update(s.problem)
      .set({ state: 'active' })
      .where(eq(s.problem.id, pids[2]));
    await db
      .update(s.problem)
      .set({ initiatorId: poster })
      .where(eq(s.problem.id, pids[2]));
    const c = await evidenceContribution(pids[2], reply.id);
    await attach(reply.id, { contributionId: c, criterionRefs: [1] }).expect(
      201,
    );
  });
});
