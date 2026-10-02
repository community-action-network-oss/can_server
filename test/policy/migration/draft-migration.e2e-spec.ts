import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { hashToken, newToken } from '../../../src/accounts/infra/crypto.js';
import { AppModule } from '../../../src/app.module.js';
import { configureApp } from '../../../src/app.setup.js';
import { config } from '../../../src/config.js';
import * as s from '../../../src/db/schema.js';
import { newId } from '../../../src/domain/ids.js';
import { CLOCK } from '../../../src/platform/ports.js';
import { FixedClock } from '../../../src/platform/testing.js';
import { TransitionEngine } from '../../../src/problems/app/transition-engine.js';
import { PolicyStore } from '../../../src/policy/app/policy-store.js';
import { ProblemFixtures } from '../../support/problems.js';
import { writeFixture } from '../build-fixture.ts';
import { FIXTURE_DIR } from '../helpers.js';

// Versions 71.x and 72.x never collide with other e2e files that share this database.
const PAIRS = join(FIXTURE_DIR, 'schema-pairs/problem');
const SCHEMA_DIR = 'base@0.0.1/content-schemas/problem';
const DAY = 86_400_000;
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
  schemaVersionPin: 'v',
};
const old = {
  title: 'Unlit crossing',
  structural_statement: 'Lights go unrepaired.',
  scope: 'city',
  assumptions: 'The city owns them.',
  impact: 'big',
};

let app: INestApplication;
let pool: pg.Pool;
let fx: ProblemFixtures;
let tmp: string;
let token: string;
let accountId: string;
const clock = new FixedClock(new Date());
const http = () => request(app.getHttpServer());
const auth = () => ({ Authorization: `Bearer ${token}` });
const post = (b: object) => http().post('/v1/drafts').set(auth()).send(b);
const patch = (id: string, b: object) =>
  http().patch(`/v1/drafts/${id}`).set(auth()).send(b);
const getMig = (id: string) =>
  http().get(`/v1/drafts/${id}/migration`).set(auth());
const postMig = (id: string, b: object) =>
  http().post(`/v1/drafts/${id}/migration`).set(auth()).send(b);
const row = async (id: string) =>
  (await pool.query('select * from problem where id = $1', [id])).rows[0];
const events = async (id: string) =>
  (
    await pool.query(
      "select payload from problem_event where problem_id = $1 and type = 'draft_schema_migrated'",
      [id],
    )
  ).rows.map((r) => r.payload);
const draft = async (content: object) => {
  const r = await post({ content }).expect(201);
  fx.problems.push(r.body.id);
  return r.body.id as string;
};

/** Writes one of the fixture schema versions (renumbered) into the tmp pack and makes it the active one. */
async function activate(file: string, version: string, mapFile?: string) {
  const j = JSON.parse(readFileSync(join(PAIRS, file), 'utf8'));
  j['x-version'] = version;
  writeFileSync(join(tmp, SCHEMA_DIR, 'schema.json'), JSON.stringify(j));
  if (mapFile) {
    const m = JSON.parse(
      readFileSync(join(PAIRS, 'migrations', mapFile), 'utf8'),
    );
    m.from = '71.1.0';
    m.to = version;
    mkdirSync(join(tmp, SCHEMA_DIR, 'migrations'), { recursive: true });
    writeFileSync(
      join(tmp, SCHEMA_DIR, 'migrations', `71.1.0-to-${version}.json`),
      JSON.stringify(m),
    );
  }
  const h = writeFixture(tmp);
  const ref = {
    name: 'fiktiva-city',
    version: '0.0.1',
    hash: h['fiktiva-city'],
  };
  if (app) await app.get(PolicyStore).activate('default', ref);
  return { default: ref };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'fixture-'));
  cpSync(FIXTURE_DIR, tmp, { recursive: true });
  config.policyPacksDir = tmp;
  config.policyActive = await activate('1.0.0.schema.json', '71.0.0');
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  const db = drizzle(pool, { schema: s });
  fx = new ProblemFixtures(db);
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  accountId = await fx.account();
  token = newToken();
  await db.insert(s.session).values({
    id: newId(),
    accountId,
    tokenHash: hashToken(token),
    expiresAt: new Date('2100-01-01'),
    absoluteExpiresAt: new Date('2100-01-01'),
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
    "delete from content_schema_version where version like '71.%' or version like '72.%'",
  );
  await pool.end();
});

describe('draft schema migration', () => {
  let a: string; // minor, migrates on edit
  let b: string; // minor, migrates on open
  let published: string;
  const minorContent = {
    title: 'Unlit crossing',
    structural_statement: 'Lights go unrepaired.',
    scope: 'city',
    assumptions: 'None.',
  };

  it('a minor bump moves drafts on edit and on open, carrying every answer', async () => {
    a = await draft(minorContent);
    b = await draft(minorContent);
    const oldHash = (await row(a)).schema_hash;
    published = await fx.problem('active', {
      initiatorId: accountId,
      publishedAt: new Date(),
      schemaId: 'fixture.problem',
      schemaVersion: '71.0.0',
      schemaHash: oldHash,
      content: minorContent,
    });
    await activate('1.1.0.schema.json', '71.1.0');

    const e = await patch(a, {
      content: minorContent,
      expectedVersion: 1,
    }).expect(200);
    expect(e.body.schemaVersion).toBe('71.1.0');
    expect(e.body.schemaHash).not.toBe(oldHash);
    expect((await row(a)).content).toEqual(minorContent);
    expect(await events(a)).toEqual([
      { from: '71.0.0', to: '71.1.0', bump: 'minor', auto: true },
    ]);

    const g = await getMig(b).expect(200);
    expect(g.body).toMatchObject({
      state: 'migrated',
      bump: 'minor',
      mapping: [],
      new_required: [],
      grace_ends_at: null,
      current: { schema_version: '71.0.0' },
      target: { schema_version: '71.1.0' },
    });
    const rb = await row(b);
    expect(rb.schema_version).toBe('71.1.0');
    expect(rb.version).toBe(2);
    expect(rb.content).toEqual(minorContent);
  });

  it('a published row keeps its schema columns and refuses migration', async () => {
    const before = await row(published);
    await getMig(published).expect(409);
    await postMig(published, { expectedVersion: 1, mappings: [] }).expect(409);
    await patch(published, { title: 'x', expectedVersion: 1 }).expect(409);
    const after = await row(published);
    for (const k of [
      'schema_id',
      'schema_version',
      'schema_hash',
      'content',
      'version',
    ])
      expect(after[k]).toEqual(before[k]);
    expect(await events(published)).toEqual([]);
  });

  describe('major bump', () => {
    let d: string;
    let e: string;
    let f: string;
    let startedAt: number;

    it('keeps drafts pinned for the grace window and previews the mapping', async () => {
      [d, e, f] = [await draft(old), await draft(old), await draft(old)];
      expect((await row(d)).schema_version).toBe('71.1.0');
      await activate('2.0.0.schema.json', '72.0.0', '1.1.0-to-2.0.0.json');
      startedAt = clock.now().getTime();

      // Editing on the old form still works and stays on 71.1.0.
      const p = await patch(d, { content: old, expectedVersion: 1 }).expect(
        200,
      );
      expect(p.body.schemaVersion).toBe('71.1.0');

      const g = await getMig(d).expect(200);
      expect(g.body).toMatchObject({
        state: 'pinned',
        bump: 'major',
        current: { schema_version: '71.1.0' },
        target: { schema_version: '72.0.0' },
        new_required: ['who_affected'],
        dropped: ['impact'],
      });
      expect(new Date(g.body.grace_ends_at).getTime()).toBe(
        startedAt + 30 * DAY,
      );
      expect(g.body.mapping).toHaveLength(4);
      expect(g.body.mapping).toContainEqual({
        from_path: 'impact',
        to_path: '',
        transform: 'drop',
        carried_value: 'big',
        needs_confirmation: true,
      });
      expect((await row(d)).schema_version).toBe('71.1.0'); // a preview never moves it
    });

    it('confirming applies only the accepted mappings and restamps', async () => {
      await postMig(d, { expectedVersion: 99, mappings: [] }).expect(409);
      const bad = await postMig(d, {
        expectedVersion: 2,
        mappings: [{ from_path: 'nope', to_path: 'x' }],
      }).expect(400);
      expect(bad.body.error.code).toBe('validation_failed');

      const r = await postMig(d, {
        expectedVersion: 2,
        mappings: [{ from_path: 'structural_statement', to_path: 'statement' }],
      }).expect(200);
      expect(r.body).toMatchObject({ schemaVersion: '72.0.0', version: 3 });
      const rd = await row(d);
      expect(rd.content).toEqual({
        title: 'Unlit crossing',
        reach: 'city',
        statement: 'Lights go unrepaired.',
      });
      expect(await events(d)).toContainEqual({
        from: '71.1.0',
        to: '72.0.0',
        bump: 'major',
        auto: false,
        confirmed: 1,
      });
      // Now on the current form: the new required field is asked fresh by the form, submit validates it.
      await getMig(d)
        .expect(200)
        .expect((x) => expect(x.body.state).toBe('migrated'));
    });

    it('submit inside the window works on the pinned form', async () => {
      const r = await app.get(TransitionEngine).apply({
        problemId: f,
        to: 'in_review',
        actor: { kind: 'initiator', id: accountId },
        fields: T01,
      });
      expect(r.state).toBe('in_review');
      expect((await row(f)).schema_version).toBe('71.1.0');
    });

    it('after the window, edits to content and submit need the migration first', async () => {
      clock.set(new Date(startedAt + 30 * DAY + 1000));
      // The idle timeout slides on every request; keep the test session alive across the jump.
      await pool.query(
        "update session set expires_at = '2100-01-01' where account_id = $1",
        [accountId],
      );
      const engine = app.get(TransitionEngine);
      const submit = () =>
        engine.apply({
          problemId: e,
          to: 'in_review',
          actor: { kind: 'initiator', id: accountId },
          fields: T01,
        });
      await expect(submit()).rejects.toMatchObject({
        code: 'schema_migration_required',
      });
      const r = await patch(e, { content: old, expectedVersion: 1 }).expect(
        409,
      );
      expect(r.body.error.code).toBe('schema_migration_required');
      await patch(e, {
        title: 'plain fields still save',
        expectedVersion: 1,
      }).expect(200);

      await postMig(e, { expectedVersion: 2, mappings: [] }).expect(200);
      // The submit gate also checks completeness: the new required answer must be given first (03-u08).
      await expect(submit()).rejects.toBeDefined();
      const migrated = (await row(e)).content;
      await patch(e, {
        content: {
          ...migrated,
          statement: 'Lights go unrepaired.',
          who_affected: 'Residents',
        },
        expectedVersion: 3,
      }).expect(200);
      expect((await submit()).state).toBe('in_review');
      expect((await row(e)).schema_version).toBe('72.0.0');
    });
  });
});
