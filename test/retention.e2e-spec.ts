import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/accounts/app/auth.service.js';
import { AuthRetention } from '../src/accounts/app/retention.js';
import { encryptEmail } from '../src/accounts/infra/crypto.js';
import { DrizzleUnitOfWork } from '../src/accounts/infra/unit-of-work.js';
import { config } from '../src/config.js';
import * as s from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { MailDecisionNotifier } from '../src/moderation/infra/notifier.js';
import { AuditPort } from '../src/platform/audit/audit.service.js';
import { UuidV7Generator } from '../src/platform/ports.js';
import { PgQueue } from '../src/platform/queue/pg-queue.js';
import { queueConfig } from '../src/platform/queue/queue.config.js';
import { QueueWorker } from '../src/platform/queue/worker.js';
import { FixedClock } from '../src/platform/testing.js';
import { ProblemRetention } from '../src/problems/app/retention.js';
import { TransitionEngine } from '../src/problems/app/transition-engine.js';
import {
  NoReviewFacts,
  NoopDecisionNotifier,
  TransitionEffects,
} from '../src/problems/app/transition-ports.js';
import { FingerprintRepo } from '../src/problems/infra/fingerprint.repo.js';
import {
  RETENTION_JOBS,
  RetentionJobs,
} from '../src/retention/retention.jobs.js';
import { ProblemFixtures } from './support/problems.js';

const DAY = 86_400_000;
// A past anchor: the jobs sweep whole tables, so tests must not reach rows other specs own.
const T0 = new Date('2020-01-01T00:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const SECRET = 'zzretentionsecret';
const EMAIL = `ret-${newId()}@example.org`;
// A capturing mail port: Mailpit is shared and other specs clear it mid-run.
const sent: { to: string; subject: string; text: string }[] = [];
const mailPort = {
  send: async (m: (typeof sent)[number]) => void sent.push(m),
};

let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
let owner: string;
let ret: ProblemRetention;
let engineClock: FixedClock;
const extra = { problems: [] as string[], stages: [] as string[] };

const row = async (id: string) =>
  (await db.select().from(s.problem).where(eq(s.problem.id, id)))[0];
const events = (id: string) =>
  db.select().from(s.problemEvent).where(eq(s.problemEvent.problemId, id));
const mails = async () => {
  await new Promise((r) => setTimeout(r, 100)); // sendTo is fire and forget
  return sent.filter((m) => m.to === EMAIL).length;
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  db = drizzle(pool, { schema: s });
  fx = new ProblemFixtures(db);
  owner = await fx.account();
  await db
    .update(s.account)
    .set({
      emailCiphertext: encryptEmail(
        EMAIL,
        Buffer.from(config.emailEncKey, 'base64'),
      ),
    })
    .where(eq(s.account.id, owner));
  engineClock = new FixedClock(T0);
  const ids = new UuidV7Generator();
  const engine = new TransitionEngine(
    db,
    engineClock,
    ids,
    new AuditPort(engineClock, ids),
    new NoReviewFacts(),
    new NoopDecisionNotifier(),
    new TransitionEffects(),
  );
  const auth = new AuthService(
    new DrizzleUnitOfWork(db, new AuditPort(engineClock, ids)),
    engineClock,
    ids,
    mailPort as never,
    { encKey: Buffer.from(config.emailEncKey, 'base64') } as never,
    undefined as never,
  );
  ret = new ProblemRetention(
    db as never,
    engine,
    new MailDecisionNotifier(db as never, auth),
  );
});
afterAll(async () => {
  const all = fx.problems;
  await db
    .delete(s.reviewRecommendation)
    .where(inArray(s.reviewRecommendation.problemId, all));
  await db.delete(s.sourceRef).where(inArray(s.sourceRef.problemId, all));
  await db
    .delete(s.acceptanceCriterion)
    .where(inArray(s.acceptanceCriterion.problemId, all));
  await db
    .delete(s.problemVersion)
    .where(inArray(s.problemVersion.problemId, all));
  await db.delete(s.stage).where(inArray(s.stage.problemId, all));
  await db.delete(s.job).where(inArray(s.job.queue, [...RETENTION_JOBS]));
  await fx.cleanup();
  await pool.end();
});

describe('retention jobs', () => {
  it('purgeDrafts: intact at day 29, scrubbed at day 31, idempotent (no caches in slice 1)', async () => {
    const reviewer = await fx.account();
    const p = await fx.problem('rejected', {
      initiatorId: owner,
      title: SECRET,
      condition: SECRET,
      content: { a: SECRET },
      intakeEvidence: [{ url: 'https://x.example', note: SECRET }],
      purgeAfter: at(30),
    });
    await db.insert(s.sourceRef).values({
      id: newId(),
      problemId: p,
      uri: 'https://x.example/a',
      category: 'other',
      establishes: SECRET,
    });
    await db.insert(s.acceptanceCriterion).values({
      id: newId(),
      problemId: p,
      statement: SECRET,
      measure: 'm',
      ordinal: 0,
    });
    await db.insert(s.problemVersion).values({
      problemId: p,
      version: 1,
      snapshot: { t: SECRET },
      createdAt: T0,
    });
    const rec = newId();
    await db.insert(s.reviewRecommendation).values({
      id: rec,
      problemId: p,
      reviewerId: reviewer,
      path: 'title',
      recommendation: SECRET,
      reason: SECRET,
      status: 'declined',
      resolutionReason: SECRET,
      openedAt: T0,
      resolvedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    });
    await db.insert(s.problemEvent).values({
      id: newId(),
      problemId: p,
      type: 'rejected',
      originNodeId: config.nodeId,
      protocolVersion: '1',
      occurredAt: T0,
    });

    await ret.purgeDrafts(at(29));
    expect((await row(p)).title).toBe(SECRET);

    await ret.purgeDrafts(at(31));
    await ret.purgeDrafts(at(31));
    const r = await row(p);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.purgedAt).not.toBeNull();
    expect(r.state).toBe('rejected');
    const [x] = await db
      .select()
      .from(s.reviewRecommendation)
      .where(eq(s.reviewRecommendation.id, rec));
    expect(x.recommendation + x.reason + x.resolutionReason).toBe('');
    expect(x.status).toBe('declined');
    for (const t of [s.sourceRef, s.acceptanceCriterion, s.problemVersion])
      expect(await db.select().from(t).where(eq(t.problemId, p))).toHaveLength(
        0,
      );
    expect(await events(p)).toHaveLength(1);
  });

  it('fingerprints are gone at day 91, kept at day 89', async () => {
    const repo = new FingerprintRepo(db);
    const h = [`ret-${newId()}`];
    await repo.store(h, 'rejected', T0);
    expect(await repo.findSimilar(h, at(89))).toBe(true);
    await repo.purgeExpired(at(91));
    const left = await db
      .select()
      .from(s.draftFingerprint)
      .where(eq(s.draftFingerprint.hashes, h));
    expect(left).toHaveLength(0);
  });

  it('cleanupAuth removes sessions 30 days past expiry and codes 24 hours past use', async () => {
    const mk = (expires: Date) => ({
      id: newId(),
      accountId: owner,
      tokenHash: Buffer.from(newId()),
      expiresAt: expires,
      absoluteExpiresAt: expires,
      clientKind: 'web',
    });
    const old = mk(T0);
    const fresh = mk(at(20));
    await db.insert(s.session).values([old, fresh]);
    const oldCode = newId();
    const liveCode = newId();
    const code = (id: string, expires: Date) => ({
      id,
      accountId: owner,
      codeHash: Buffer.from(id),
      expiresAt: expires,
    });
    await db
      .insert(s.loginCode)
      .values([code(oldCode, T0), code(liveCode, at(40))]);
    await new AuthRetention(db as never).cleanupAuth(at(31));
    const left = await db
      .select({ id: s.session.id })
      .from(s.session)
      .where(inArray(s.session.id, [old.id, fresh.id]));
    expect(left.map((x) => x.id)).toEqual([fresh.id]);
    const codes = await db
      .select({ id: s.loginCode.id })
      .from(s.loginCode)
      .where(inArray(s.loginCode.id, [oldCode, liveCode]));
    expect(codes.map((x) => x.id)).toEqual([liveCode]);
    await db.delete(s.session).where(eq(s.session.id, fresh.id));
    await db.delete(s.loginCode).where(eq(s.loginCode.id, liveCode));
  });

  it('idleRevisions: one reminder at day 23, auto-withdraw by system at day 30', async () => {
    const p = await fx.problem('needs_revision', {
      initiatorId: owner,
      updatedAt: T0,
    });
    expect(await ret.idleRevisions(at(22))).toEqual({
      reminded: 0,
      withdrawn: 0,
    });
    expect((await ret.idleRevisions(at(23))).reminded).toBe(1);
    await mails();
    const got = sent.find((m) => m.to === EMAIL)!;
    expect(got.subject).toContain('still needs changes');
    expect(got.text).toContain(`/me/problems/${p}`);
    expect((await ret.idleRevisions(at(24))).reminded).toBe(0);
    expect((await ret.idleRevisions(at(25))).reminded).toBe(0);
    expect(await mails()).toBe(1);

    engineClock.set(at(30));
    expect(await ret.idleRevisions(at(30))).toEqual({
      reminded: 0,
      withdrawn: 1,
    });
    expect(await ret.idleRevisions(at(30))).toEqual({
      reminded: 0,
      withdrawn: 0,
    });
    engineClock.set(T0);
    const r = await row(p);
    expect(r.state).toBe('withdrawn');
    expect(r.purgeAfter).toEqual(at(60));
    const ev = (await events(p)).find((e) => e.toState === 'withdrawn');
    expect(ev?.actorId).toBeNull();
    expect(ev?.payload).toMatchObject({ transitionId: 'T07' });
  });

  it('enqueueAll is deduped per window, so a second worker or tick adds nothing', async () => {
    const clock = new FixedClock(at(100));
    const ids = new UuidV7Generator();
    const queue = new PgQueue(
      db as never,
      clock,
      ids,
      { next: () => 1 },
      queueConfig,
      new AuditPort(clock, ids),
    );
    const jobs = new RetentionJobs(
      ret,
      new AuthRetention(db as never),
      new FingerprintRepo(db),
      queue,
      new QueueWorker(queue, queueConfig),
      clock,
    );
    const a = await jobs.enqueueAll();
    const b = await jobs.enqueueAll();
    expect(b).toEqual(a);
    const rows = await db
      .select()
      .from(s.job)
      .where(
        and(
          inArray(s.job.queue, [...RETENTION_JOBS]),
          eq(s.job.status, 'queued'),
        ),
      );
    expect(rows).toHaveLength(RETENTION_JOBS.length);
    expect(JSON.stringify(rows.map((r) => r.payload))).toMatch(/window/);
  });
});
