import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
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
import { SubmitChecks } from '../src/problems/app/submit-checks.service.js';
import { ProblemFixtures } from './support/problems.js';

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
let alice: string;
let token: string;
const auth = () => ({ Authorization: `Bearer ${token}` });
const http = () => request(app.getHttpServer());
const row = async (id: string) =>
  (await db.select().from(s.problem).where(eq(s.problem.id, id)))[0]!;
const mk = (state: string, o: Partial<typeof s.problem.$inferInsert> = {}) =>
  fx.problem(state, { initiatorId: alice, ...o });
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
const submit = (id: string, fields: object = T01) =>
  http()
    .post(`/v1/drafts/${id}/transitions`)
    .set(auth())
    .send({ to: 'in_review', fields });
const CLEAN = {
  condition: 'The bus stop on the main road has no shelter and floods in rain.',
  affected: 'Commuters and school children who wait there each morning.',
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
  alice = await fx.account();
  token = newToken();
  await db.insert(s.session).values({
    id: newId(),
    accountId: alice,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000),
    clientKind: 'native',
  });
});
afterAll(async () => {
  await app.close();
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

describe('submit gate (T01)', () => {
  it('a clean draft submits, with snapshot and check stamps', async () => {
    const d = await mk('draft', CLEAN);
    const r = await submit(d).expect(200);
    expect(r.body.state).toBe('in_review');
    const p = await row(d);
    expect(p.submitSnapshot?.fields.condition).toBe(CLEAN.condition);
    expect(p.repostMatch).toBe(false);
    expect(p.privacyCheckAt).not.toBeNull();
  });

  it.each([
    ['phone', 'condition', 'Call me on +44 7700 900123 about the stop.'],
    ['email', 'affected', 'Write to jane.doe@example.com for more.'],
    ['secret', 'observed', 'The api key is AKIAABCDEFGHIJKLMNOP in the note.'],
  ])(
    'a %s blocks, names the field, and leaves the draft',
    async (_k, field, text) => {
      const d = await mk('draft', { [field]: text });
      const r = await submit(d).expect(400);
      expect(r.body.error.code).toBe('validation_failed');
      expect(Object.keys(r.body.error.fieldErrors)).toEqual([field]);
      expect(JSON.stringify(r.body)).not.toContain(text);
      expect((await row(d)).state).toBe('draft');
      expect(
        (
          await db
            .select()
            .from(s.problemEvent)
            .where(eq(s.problemEvent.problemId, d))
        ).length,
      ).toBe(0);
    },
  );

  it('over length and an unsafe evidence URL block', async () => {
    const d = await mk('draft', {
      title: 'x'.repeat(500),
      intakeEvidence: [{ url: 'javascript:alert(1)', note: 'n' }],
    });
    const r = await submit(d).expect(400);
    expect(Object.keys(r.body.error.fieldErrors).sort()).toEqual([
      '/intakeEvidence/0/url',
      'title',
    ]);
  });

  it('a name candidate blocks until kept, then passes and is stored as an input only', async () => {
    const d = await mk('draft', {
      condition: 'The clerk Maria Gonzalez refuses every request at the desk.',
    });
    await submit(d).expect(400);
    const c = await http()
      .post(`/v1/drafts/${d}/checks`)
      .set(auth())
      .expect(200);
    const review = c.body.flags.filter(
      (f: { severity: string }) => f.severity === 'review',
    );
    expect(review.length).toBeGreaterThan(0);
    expect(c.body.ok).toBe(false);
    const k = await http()
      .post(`/v1/drafts/${d}/checks/keep`)
      .set(auth())
      .send({ flagIds: review.map((f: { id: string }) => f.id) })
      .expect(200);
    expect(k.body.ok).toBe(true);
    await submit(d).expect(200);
    expect((await row(d)).keptFlags?.length).toBe(review.length);
    const pub = await http().get(`/v1/problems/${d}`).set(auth()).expect(200);
    expect(JSON.stringify(pub.body)).not.toContain('keptFlags');
  });

  it('keep refuses hard flags and unknown ids', async () => {
    const d = await mk('draft', {
      condition: 'Call +44 7700 900123 now please.',
    });
    const c = await http()
      .post(`/v1/drafts/${d}/checks`)
      .set(auth())
      .expect(200);
    const hard = c.body.flags.find(
      (f: { severity: string }) => f.severity === 'hard',
    );
    await http()
      .post(`/v1/drafts/${d}/checks/keep`)
      .set(auth())
      .send({ flagIds: [hard.id] })
      .expect(400);
    await http()
      .post(`/v1/drafts/${d}/checks/keep`)
      .set(auth())
      .send({ flagIds: ['nope'] })
      .expect(400);
  });

  it('emergency wording is flagged, not rejected, and needs an acknowledgement', async () => {
    const d = await mk('draft', {
      condition: 'Someone said help me, I am in danger at the stop.',
    });
    const c = await http()
      .post(`/v1/drafts/${d}/checks`)
      .set(auth())
      .expect(200);
    expect(c.body.emergency).toBe(true);
    const r = await submit(d).expect(400);
    expect(r.body.error.fieldErrors.emergencyAcknowledged).toBe('required');
    await submit(d, { ...T01, emergencyAcknowledged: true }).expect(200);
  });

  it('an internal failure in the checks leaves the state unchanged', async () => {
    const d = await mk('draft', CLEAN);
    const gate = app.get(SubmitChecks);
    const spy = vi
      .spyOn(gate, 'check')
      .mockRejectedValueOnce(new Error('boom'));
    await submit(d).expect(500);
    spy.mockRestore();
    expect((await row(d)).state).toBe('draft');
  });

  it('a repost match is advisory and recorded', async () => {
    const d = await mk('draft', CLEAN);
    const fp = (
      app.get(SubmitChecks) as unknown as {
        fingerprints: import('../src/problems/infra/fingerprint.repo.js').FingerprintRepo;
      }
    ).fingerprints;
    const sk = fp.sketch(
      ['Transition engine fixture', CLEAN.condition, CLEAN.affected].join('\n'),
    );
    await fp.store(sk, 'rejected', new Date());
    try {
      const c = await http()
        .post(`/v1/drafts/${d}/checks`)
        .set(auth())
        .expect(200);
      expect(c.body.repostMatch).toBe(true);
      await submit(d).expect(200);
      expect((await row(d)).repostMatch).toBe(true);
    } finally {
      await fp.deleteMatching(sk, new Date());
    }
  });
});

describe('T03', () => {
  it('needs a changed field versus the snapshot', async () => {
    const d = await mk('draft', CLEAN);
    await submit(d).expect(200);
    await db
      .update(s.problem)
      .set({ state: 'needs_revision' })
      .where(eq(s.problem.id, d));
    const same = await http()
      .post(`/v1/drafts/${d}/transitions`)
      .set(auth())
      .send({ to: 'in_review', fields: { changedFlaggedField: 'condition' } })
      .expect(400);
    expect(same.body.error.fieldErrors.changedFlaggedField).toBeDefined();
    await db
      .update(s.problem)
      .set({ condition: CLEAN.condition + ' It also lacks a bench.' })
      .where(eq(s.problem.id, d));
    await http()
      .post(`/v1/drafts/${d}/transitions`)
      .set(auth())
      .send({ to: 'in_review', fields: { changedFlaggedField: 'condition' } })
      .expect(200);
  });
});

describe('preview and actions', () => {
  it('preview keys and values equal the public detail once published', async () => {
    const d = await mk('draft', {
      ...CLEAN,
      title: 'Shelterless stop',
      coarseArea: 'Riverside',
    });
    const pv = await http()
      .get(`/v1/drafts/${d}/preview`)
      .set(auth())
      .expect(200);
    await db
      .update(s.problem)
      .set({ state: 'active', publishedAt: new Date() })
      .where(eq(s.problem.id, d));
    const pub = await http().get(`/v1/problems/${d}`).expect(200);
    for (const [k, v] of Object.entries(pv.body.public))
      expect(pub.body[k], k).toEqual(v);
    expect(pv.body.handle).toBe(pub.body.authorHandle);
    expect(pv.body.explanationIds.length).toBeGreaterThan(0);
  });

  it('preview and checks are author-only and 404 for a published problem', async () => {
    const d = await mk('draft');
    await http().get(`/v1/drafts/${d}/preview`).expect(401);
    const a = await mk('active', { publishedAt: new Date() });
    await http().post(`/v1/drafts/${a}/checks`).set(auth()).expect(404);
  });

  it('submit is offered as an action from draft', async () => {
    const d = await mk('draft');
    const r = await http()
      .get(`/v1/drafts/${d}/actions`)
      .set(auth())
      .expect(200);
    expect(
      r.body.actions.some((x: { to: string }) => x.to === 'in_review'),
    ).toBe(true);
  });
});
