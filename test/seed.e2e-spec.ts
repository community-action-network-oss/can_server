import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { config } from '../src/config.js';
import {
  FIXTURE_PROBLEM_IDS,
  FIXTURE_PUBLIC_IDS,
  seedFictionalFixture,
} from '../src/seed/fixtures.js';
import { SEED_IDS, seedWorld, sid } from '../src/seed/world.js';

let app: INestApplication;
let pool: pg.Pool;
const accountIds = Array.from({ length: 7 }, (_, i) => sid(0x101 + i));
const count = async (sql: string, ids: string[]) =>
  Number((await pool.query(sql, [ids])).rows[0].n);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
});

// Children first; only rows this test (and the seed) own by fixed id, plus FK children of its accounts.
const cleanup = async () => {
  // Sign-ins as seeded members (login_code, session) and invites hang off the fixed-id accounts.
  await pool.query('delete from login_code where account_id = any($1)', [
    accountIds,
  ]);
  await pool.query('delete from session where account_id = any($1)', [
    accountIds,
  ]);
  await pool.query(
    'delete from invite where issued_by = any($1) or redeemed_by = any($1)',
    [accountIds],
  );
  await pool.query('delete from problem_event where problem_id = any($1)', [
    FIXTURE_PROBLEM_IDS,
  ]);
  await pool.query('delete from problem where id = any($1)', [
    FIXTURE_PROBLEM_IDS,
  ]);
  await pool.query('delete from account where id = any($1)', [accountIds]);
  await pool.query('delete from jurisdiction where id = any($1)', [
    [SEED_IDS.amsterdam, SEED_IDS.fiktiva],
  ]);
};

beforeAll(cleanup);

afterAll(async () => {
  await cleanup();
  await pool.end();
  await app.close();
});

describe('seed', () => {
  it('is idempotent and publishes no problem by default', async () => {
    const a = await seedWorld(pool);
    const b = await seedWorld(pool);
    expect(a.accounts).toEqual(b.accounts);
    expect(
      await count(
        'select count(*) n from account where id = any($1)',
        accountIds,
      ),
    ).toBe(7);
    expect(
      await count('select count(*) n from invite where issued_by = any($1)', [
        SEED_IDS.stewardOne,
      ]),
    ).toBe(3);
    expect(
      await count(
        'select count(*) n from problem where id = any($1)',
        FIXTURE_PROBLEM_IDS,
      ),
    ).toBe(0);
    const v = await pool.query(
      "select count(*) filter (where volunteer_reviewer) v, count(*) filter (where role='moderator') m from account where id = any($1)",
      [accountIds],
    );
    expect(v.rows[0]).toEqual({ v: '3', m: '2' });
  });

  it('stores no plaintext email and marks jurisdictions', async () => {
    const cols = await pool.query(
      "select column_name from information_schema.columns where table_name='account' and column_name ilike '%email%'",
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
      'email_ciphertext',
      'email_hmac',
    ]);
    const raw = await pool.query(
      'select email_ciphertext from account where id = any($1)',
      [accountIds],
    );
    for (const r of raw.rows)
      expect(r.email_ciphertext.toString('utf8')).not.toContain('example.org');
    const j = await pool.query(
      'select id, is_fictional, enabled from jurisdiction where id = any($1)',
      [[SEED_IDS.amsterdam, SEED_IDS.fiktiva]],
    );
    const byId = Object.fromEntries(j.rows.map((r) => [r.id, r]));
    expect(byId[SEED_IDS.amsterdam]).toMatchObject({
      is_fictional: false,
      enabled: true,
    });
    expect(byId[SEED_IDS.fiktiva]).toMatchObject({ is_fictional: true });
  });

  it('fixture exposes 5 public problems and no private ones', async () => {
    await seedFictionalFixture(pool);
    await seedFictionalFixture(pool);
    expect(
      await count(
        'select count(*) n from problem where id = any($1) and is_seed and synthetic_evidence',
        FIXTURE_PROBLEM_IDS,
      ),
    ).toBe(7);
    const list = await request(app.getHttpServer())
      .get('/v1/problems?limit=100')
      .expect(200);
    const listed: string[] = list.body.items.map((i: { id: string }) => i.id);
    for (const id of FIXTURE_PROBLEM_IDS)
      expect(listed.includes(id)).toBe(FIXTURE_PUBLIC_IDS.includes(id));
    for (const id of FIXTURE_PUBLIC_IDS)
      await request(app.getHttpServer()).get(`/v1/problems/${id}`).expect(200);
    for (const id of FIXTURE_PROBLEM_IDS.filter(
      (i) => !FIXTURE_PUBLIC_IDS.includes(i),
    ))
      await request(app.getHttpServer()).get(`/v1/problems/${id}`).expect(404);
  });
});
