import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { hashToken, newToken } from '../../src/accounts/infra/crypto.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { config } from '../../src/config.js';
import * as s from '../../src/db/schema.js';
import { newId } from '../../src/domain/ids.js';
import { PolicyStore } from '../../src/policy/app/policy-store.js';
import { ProblemFixtures } from '../support/problems.js';
import { writeFixture } from './build-fixture.ts';
import { FIXTURE_DIR } from './helpers.js';

// Versions 9.x never collide with the fixture's own 1.0.0 that other e2e files stamp in parallel.
const SCHEMA = 'base@0.0.1/content-schemas/problem/schema.json';
const ok = {
  title: 'Unlit crossing',
  structural_statement: 'Lights go unrepaired.',
  scope: 'street',
  assumptions: 'None.',
};

let app: INestApplication;
let pool: pg.Pool;
let fx: ProblemFixtures;
let tmp: string;
let token: string;
const http = () => request(app.getHttpServer());
const auth = () => ({ Authorization: `Bearer ${token}` });
const post = (b: object) => http().post('/v1/drafts').set(auth()).send(b);
const patch = (id: string, b: object) =>
  http().patch(`/v1/drafts/${id}`).set(auth()).send(b);
const pin = (h: Record<string, string>) => ({
  default: { name: 'fiktiva-city', version: '0.0.1', hash: h['fiktiva-city'] },
});

function publish(version: string, extraRequired: boolean) {
  const f = join(tmp, SCHEMA);
  const j = JSON.parse(readFileSync(join(FIXTURE_DIR, SCHEMA), 'utf8'));
  j['x-version'] = version;
  if (extraRequired) {
    j.required = [...j.required, 'extra'];
    j.properties.extra = { type: 'string', maxLength: 5 };
  }
  writeFileSync(f, JSON.stringify(j));
  return pin(writeFixture(tmp));
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'fixture-'));
  cpSync(FIXTURE_DIR, tmp, { recursive: true });
  config.policyPacksDir = tmp;
  config.policyActive = publish('9.1.0', false);
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  fx = new ProblemFixtures(drizzle(pool, { schema: s }));
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  const acct = await fx.account();
  token = newToken();
  await drizzle(pool, { schema: s })
    .insert(s.session)
    .values({
      id: newId(),
      accountId: acct,
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
  await pool.query(
    "delete from content_schema_version where version like '9.%'",
  );
  await pool.end();
});

describe('structured drafts pin a schema version', () => {
  let oldId: string;
  let oldHash: string;

  it('create stamps the active schema and validates content', async () => {
    const r = await post({ title: 'Light', content: ok }).expect(201);
    fx.problems.push(r.body.id);
    oldId = r.body.id;
    oldHash = r.body.schemaHash;
    expect(r.body).toMatchObject({
      schemaId: 'fixture.problem',
      schemaVersion: '9.1.0',
    });
    expect(oldHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('schema_invalid carries a JSON pointer per violation and no limit value', async () => {
    const r = await post({
      content: { ...ok, scope: 'planet', stray: 1 },
    }).expect(400);
    expect(r.body.error.code).toBe('schema_invalid');
    expect(Object.keys(r.body.error.fieldErrors).sort()).toEqual([
      '/scope',
      '/stray',
    ]);
    expect(JSON.stringify(r.body)).not.toMatch(/\d/);
  });

  it('a partial draft saves; unknown and mismatched versions say reload', async () => {
    const p = await post({ content: { title: 'Only a title' } }).expect(201);
    fx.problems.push(p.body.id);
    const u = await post({ content: ok, schemaVersion: '0.0.0' }).expect(409);
    expect(u.body.error).toMatchObject({
      code: 'schema_unknown',
      reload: true,
    });
    const m = await post({
      content: ok,
      schemaVersion: '9.1.0',
      schemaHash: 'f'.repeat(64),
    }).expect(409);
    expect(m.body.error).toMatchObject({
      code: 'schema_hash_mismatch',
      reload: true,
    });
  });

  it('after a new version is active, an old draft still validates by its stamp', async () => {
    const next = publish('9.2.0', true);
    await app.get(PolicyStore).activate('default', next.default);
    // `extra` exists only in 9.2.0, so the old draft (stamped 9.1.0) must reject it.
    const bad = { ...ok, extra: 'far too long for the new field' };
    await patch(oldId, { content: bad, expectedVersion: 1 }).expect(400);
    const good = await patch(oldId, { content: ok, expectedVersion: 1 }).expect(
      200,
    );
    expect(good.body).toMatchObject({
      schemaVersion: '9.1.0',
      schemaHash: oldHash,
    });

    const fresh = await post({ content: { ...ok, extra: 'ok' } }).expect(201);
    fx.problems.push(fresh.body.id);
    expect(fresh.body.schemaVersion).toBe('9.2.0');
  });

  it('asking for the retired version is schema_retired; editing with the wrong hash reloads', async () => {
    const r = await post({
      content: ok,
      schemaVersion: '9.1.0',
      schemaHash: oldHash,
    }).expect(409);
    expect(r.body.error.code).toBe('schema_retired');
    const m = await patch(oldId, {
      content: ok,
      schemaHash: 'e'.repeat(64),
      expectedVersion: 2,
    }).expect(409);
    expect(m.body.error).toMatchObject({
      code: 'schema_hash_mismatch',
      reload: true,
    });
  });

  it('discarding a draft scrubs its structured content', async () => {
    await http().delete(`/v1/drafts/${oldId}`).set(auth()).expect(204);
    const { rows } = await pool.query(
      'select content from problem where id = $1',
      [oldId],
    );
    expect(rows[0].content).toBeNull();
  });
});
