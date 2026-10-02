import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { config } from '../src/config.js';
import { newId } from '../src/domain/ids.js';
import { FIXTURE_DIR } from './policy/helpers.js';
import { writeFixture } from './policy/build-fixture.ts';

let app: INestApplication;
let pool: pg.Pool;
let packHash: string;

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fixture-'));
  cpSync(FIXTURE_DIR, tmp, { recursive: true });
  packHash = writeFixture(tmp)['fiktiva-city'];
  config.policyPacksDir = tmp;
  config.policyActive = {
    default: { name: 'fiktiva-city', version: '0.0.1', hash: packHash },
  };
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /v1/rules', () => {
  it('serves the active pack rules to a guest, with no stored copy', async () => {
    const res = await request(app.getHttpServer()).get('/v1/rules').expect(200);
    expect(res.body.policyVersion).toMatch(
      /^fiktiva-city@0\.0\.1\+[0-9a-f]{12}$/,
    );
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const i of res.body.items) expect(i.plainText).toBeTruthy();
    // the registry is the pack: LIMIT-1 (invented in 03-u08) is not in it
    expect(ids).not.toContain('LIMIT-1');
  });

  it('has no queue or decision-writing route', async () => {
    const h = () => request(app.getHttpServer());
    await h().get('/v1/moderation/queue').expect(404);
    await h().post('/v1/moderation/decisions').send({}).expect(404);
  });
});

const base = {
  target_type: 'problem',
  outcome: 'rejected',
  rule_ids: '{SCOPE-1}',
  field_ref: 'title',
  revision_hint: 'narrow it',
  span_start: null as number | null,
  span_end: null as number | null,
  safety_sensitive: false,
};
const ins = (c: pg.PoolClient, o: Partial<typeof base>) => {
  const r = { ...base, ...o };
  return c.query(
    `insert into moderation_decision (id,target_type,target_id,outcome,rule_ids,field_ref,span_start,span_end,revision_hint,safety_sensitive,policy_version,public_explanation,appealable_until)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'v','why',now() + interval '30 days')`,
    [
      newId(),
      r.target_type,
      newId(),
      r.outcome,
      r.rule_ids,
      r.field_ref,
      r.span_start,
      r.span_end,
      r.revision_hint,
      r.safety_sensitive,
    ],
  );
};

describe('moderation_decision constraints (MOD-EXPLAIN-1)', () => {
  let c: pg.PoolClient;
  beforeAll(async () => {
    c = await pool.connect();
    await c.query('begin');
  });
  afterAll(async () => {
    await c.query('rollback');
    c.release();
  });
  const fails = async (o: Partial<typeof base>, re: RegExp) => {
    await c.query('savepoint s');
    await expect(ins(c, o)).rejects.toThrow(re);
    await c.query('rollback to s');
  };

  it('accepts a complete rejection and a plain publish', async () => {
    await ins(c, {});
    await ins(c, {
      outcome: 'published',
      field_ref: null,
      revision_hint: null,
    });
  });
  it('rejects empty rule_ids', () => fails({ rule_ids: '{}' }, /rule_ids_chk/));
  it('rejects a rejection without field_ref', () =>
    fails({ field_ref: null }, /explain_chk/));
  it('rejects null hint unless safety_sensitive', async () => {
    await fails({ revision_hint: null }, /explain_chk/);
    await ins(c, { revision_hint: null, safety_sensitive: true });
  });
  it('rejects half or inverted spans', async () => {
    await fails({ span_start: 1 }, /span_chk/);
    await fails({ span_start: 5, span_end: 5 }, /span_chk/);
    await ins(c, { span_start: 1, span_end: 5 });
  });
  it('rejects unknown target_type and outcome', async () => {
    await fails({ target_type: 'x' }, /target_type_chk/);
    await fails({ outcome: 'maybe' }, /outcome_chk/);
  });
  it('is insert-only for can_app_rw', async () => {
    await ins(c, {});
    await c.query('set local role can_app_rw');
    for (const sql of [
      `update moderation_decision set outcome='published'`,
      `delete from moderation_decision`,
    ]) {
      await c.query('savepoint s');
      await expect(c.query(sql)).rejects.toThrow(/permission denied/);
      await c.query('rollback to s');
    }
    await c.query('reset role');
  });
});
