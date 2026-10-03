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
import { EvidenceTierService } from '../src/contributions/app/evidence-tier.service.js';
import { config } from '../src/config.js';
import * as s from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { ratifiedV1 } from './policy/helpers.js';
import { ProblemFixtures } from './support/problems.js';

const saved = { dir: config.policyPacksDir, active: config.policyActive };
const MIN = 60_000;
const EX = join(
  process.cwd(),
  'test/fixtures/policy-v1/base@1.0.0/content-schemas',
  'contribution.observation',
  'examples/valid-1.json',
);

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
let tier: EvidenceTierService;
const made: string[] = [];

const http = () => request(app.getHttpServer());
const person = async () => {
  const id = await fx.account();
  const token = newToken();
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
const row = async (
  authorId: string,
  problemId: string,
  o: Partial<typeof s.contribution.$inferInsert> = {},
  urls: { url: string; kind: string }[] = [],
) => {
  const id = newId();
  made.push(id);
  await db.insert(s.contribution).values({
    id,
    problemId,
    authorId,
    type: 'evidence',
    body: {},
    status: 'accepted',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    originNodeId: config.nodeId,
    protocolVersion: '1',
    ...o,
  });
  for (const u of urls)
    await db.insert(s.evidenceRef).values({
      id: newId(),
      contributionId: id,
      url: u.url,
      kind: u.kind,
      addedAt: new Date('2020-01-01T00:00:00Z'),
    });
  return id;
};
const publish = (id: string, override?: { tier: number; runId: string }) =>
  db.transaction((tx) =>
    tier.onPublished(tx, { contributionId: id, override }),
  );
const prob = async (id: string) =>
  (await db.select().from(s.problem).where(eq(s.problem.id, id)))[0]!;
const events = async (id: string) =>
  db
    .select()
    .from(s.problemEvent)
    .where(eq(s.problemEvent.problemId, id))
    .then((r) => r.filter((e) => e.type === 'evidence_tier_changed'));
const decide = (
  targetId: string,
  outcome: string,
  createdAt: Date,
  extra: Partial<typeof s.moderationDecision.$inferInsert> = {},
) =>
  db.insert(s.moderationDecision).values({
    id: newId(),
    targetType: 'contribution',
    targetId,
    outcome,
    ruleIds: ['R1'],
    fieldRef: '/body',
    revisionHint: 'h',
    policyVersion: '1.0.0',
    publicExplanation: 'e',
    appealableUntil: new Date(createdAt.getTime() + 86_400_000),
    createdAt,
    ...extra,
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
  tier = app.get(EvidenceTierService);
});
afterAll(async () => {
  await app.close();
  config.policyPacksDir = saved.dir;
  config.policyActive = saved.active;
  const all = fx.problems;
  const cs = await db
    .select({ id: s.contribution.id })
    .from(s.contribution)
    .where(inArray(s.contribution.problemId, all));
  const ids = [...new Set([...cs.map((c) => c.id), ...made])];
  if (ids.length) {
    await pool.query(
      'delete from moderation_decision where target_id = any($1)',
      [ids],
    );
    await db
      .delete(s.evidenceRef)
      .where(inArray(s.evidenceRef.contributionId, ids));
    await db.delete(s.contribution).where(inArray(s.contribution.id, ids));
  }
  await pool.query('delete from session where account_id = any($1)', [
    fx.accounts,
  ]);
  await fx.cleanup();
  await pool.end();
});

describe('evidence tier recompute (hook)', () => {
  it('official-page evidence flips investigation_needed once; no route sets it', async () => {
    const a = await fx.account();
    const p = await fx.problem('active', {
      evidenceTier: '1',
      investigationNeeded: true,
    });
    const c = await row(a, p, {}, [
      { url: 'https://x.gov/a', kind: 'official_page' },
    ]);
    expect(await publish(c)).toEqual({ tier: 4, changed: true });
    const got = await prob(p);
    expect([
      got.evidenceTier,
      got.investigationNeeded,
      got.evidenceTierSource,
    ]).toEqual(['4', false, 'deterministic']);
    const refs = await db
      .select()
      .from(s.evidenceRef)
      .where(eq(s.evidenceRef.contributionId, c));
    expect(refs[0]!.tier).toBe(4);
    await publish(c); // again: no second event
    const ev = await events(p);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({
      from: 1,
      to: 4,
      source: 'deterministic',
      contributionId: c,
    });
    // derived only: no write route exists for it
    const r = await http()
      .patch(`/v1/me/problems/${p}`)
      .send({ investigationNeeded: true });
    expect([401, 403, 404]).toContain(r.status);
  });

  it('ignores pending rows and verification evidence; a weak link keeps tier 2 and the flag', async () => {
    const a = await fx.account();
    const p = await fx.problem('active');
    await row(a, p, { status: 'pending_review' }, [
      { url: 'https://x.gov/b', kind: 'official_page' },
    ]);
    await row(a, p, { type: 'verification_evidence' }, [
      { url: 'https://x.gov/c', kind: 'official_page' },
    ]);
    const c = await row(a, p, {}, [
      { url: 'https://blog.example/d', kind: 'other' },
    ]);
    expect(await publish(c)).toEqual({ tier: 2, changed: true });
    expect((await prob(p)).investigationNeeded).toBe(true);
    const v = await row(a, p, { type: 'verification_evidence' }, [
      { url: 'https://x.gov/e', kind: 'official_page' },
    ]);
    expect(await publish(v)).toBeNull();
  });

  it('a DP-EVIDENCE-TIER override is stored with its source and not lowered by a later deterministic recompute', async () => {
    const a = await fx.account();
    const p = await fx.problem('active');
    const c1 = await row(a, p, {}, [
      { url: 'https://blog.example/f', kind: 'other' },
    ]);
    await publish(c1, { tier: 5, runId: newId() });
    expect((await prob(p)).evidenceTierSource).toBe('dp_evidence_tier');
    const c2 = await row(a, p, {}, [
      { url: 'https://blog.example/g', kind: 'other' },
    ]);
    expect(await publish(c2)).toEqual({ tier: 5, changed: false });
    expect((await prob(p)).evidenceTier).toBe('5');
    await expect(publish(c2, { tier: 9, runId: newId() })).rejects.toThrow();
  });
});

describe('after-rejection cooldown from decisions', () => {
  const active = () => fx.problem('active', { publishedAt: new Date() });
  const post = (h: Record<string, string>, p: string) =>
    http()
      .post(`/v1/contributions/by-problem/${p}`)
      .set(h)
      .send({
        type: 'observation',
        body: JSON.parse(readFileSync(EX, 'utf8')),
      });

  it('a recent publish decision does not start the cooldown', async () => {
    const u = await person();
    const p = await active();
    const c = await row(u.id, p, { status: 'pending_review' });
    await decide(c, 'published', new Date(Date.now() - MIN), {
      fieldRef: null,
      revisionHint: null,
    });
    expect((await post(u.h, p)).status).toBe(201);
  });

  it('a recent rejected decision blocks with cooldown_active; an old one does not', async () => {
    const u = await person();
    const p = await active();
    const c = await row(u.id, p, { status: 'pending_review' });
    await decide(c, 'rejected', new Date(Date.now() - 2 * MIN));
    const blocked = await post(u.h, p);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code ?? blocked.body.error?.code).toBe(
      'cooldown_active',
    );
    const u2 = await person();
    const p2 = await active();
    const c2 = await row(u2.id, p2, { status: 'pending_review' });
    await decide(c2, 'needs_revision', new Date(Date.now() - 30 * MIN));
    expect((await post(u2.h, p2)).status).toBe(201);
  });
});
