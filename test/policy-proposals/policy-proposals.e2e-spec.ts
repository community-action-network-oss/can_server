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
import { hashToken, newToken } from '../../src/accounts/infra/crypto.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { config } from '../../src/config.js';
import * as s from '../../src/db/schema.js';
import { newId } from '../../src/domain/ids.js';
import { ProblemFixtures } from '../support/problems.js';
import { writeFixture } from '../policy/build-fixture.ts';
import { FIXTURE_DIR } from '../policy/helpers.js';

const FX = join(process.cwd(), 'test/fixtures/policy-proposals');
const json = (f: string) => JSON.parse(readFileSync(join(FX, f), 'utf8'));
const ok = () => json('proposal.ok.json');

let app: INestApplication;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
const tokens: Record<string, string> = {};
const accounts: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const submit = (who: string, content: object) =>
  http().post('/v1/policy-proposals').set(as(who)).send({ content });
const count = async (accountId: string) =>
  (
    await pool.query(
      'select count(*)::int n from policy_proposal where account_id=$1',
      [accountId],
    )
  ).rows[0].n as number;

async function login(who: string, role = 'member') {
  const id = (accounts[who] = await fx.account());
  if (role !== 'member')
    await pool.query('update account set role=$1 where id=$2', [role, id]);
  tokens[who] = newToken();
  await db.insert(s.session).values({
    id: newId(),
    accountId: id,
    tokenHash: hashToken(tokens[who]),
    expiresAt: new Date(Date.now() + 3_600_000),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000),
    clientKind: 'native',
  });
}

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pp-fixture-'));
  cpSync(FIXTURE_DIR, tmp, { recursive: true });
  const dir = join(tmp, 'base@0.0.1/content-schemas/policy_proposal');
  mkdirSync(dir, { recursive: true });
  const schema = json('policy_proposal.schema.json');
  schema['x-version'] = '11.0.0'; // never collides with other e2e files' versions
  writeFileSync(join(dir, 'schema.json'), JSON.stringify(schema));
  cpSync(
    join(FX, 'policy_proposal.messages.en.json'),
    join(dir, 'messages.en.json'),
  );
  const h = writeFixture(tmp);
  config.policyPacksDir = tmp;
  config.policyActive = {
    default: {
      name: 'fiktiva-city',
      version: '0.0.1',
      hash: h['fiktiva-city'],
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
  for (const who of ['a', 'b', 'cap', 'refuse']) await login(who);
  await login('admin', 'admin');
});

afterAll(async () => {
  await app.close();
  const ids = Object.values(accounts);
  const own = `select id from policy_proposal where account_id = any($1)`;
  await pool.query(`delete from events where object_id in (${own})`, [ids]);
  await pool.query(
    'delete from audit_event where subject_id in (select id from policy_proposal where account_id = any($1))',
    [ids],
  );
  await pool.query('delete from policy_proposal where account_id = any($1)', [
    ids,
  ]);
  await pool.query('delete from session where account_id = any($1)', [ids]);
  await pool.query(
    "delete from content_schema_version where version = '11.0.0'",
  );
  await fx.cleanup();
  await pool.end();
});

describe('submit', () => {
  let id: string;
  it('stores a valid proposal as submitted and logs one event and audit row', async () => {
    const r = await submit('a', ok()).expect(201);
    id = r.body.id;
    expect(r.body).toMatchObject({
      stage: 'submitted',
      schemaVersion: '11.0.0',
      prUrl: null,
      eval: null,
      replay: null,
      rollout: [],
      protectedCoreFlag: false,
      ratification: { panelStatus: 'not_started', transitional: true },
    });
    expect(r.body.body.rule_ids_and_dps_touched).toEqual(['FIX-PRIV-1']);
    expect(JSON.stringify(r.body)).not.toContain(accounts.a);
    const ev = await pool.query(
      'select event_type, payload from events where object_id=$1',
      [id],
    );
    expect(ev.rows.map((x) => x.event_type)).toEqual([
      'policy_proposal.submitted',
    ]);
    expect(JSON.stringify(ev.rows)).not.toContain('Ask for the place');
    const au = await pool.query(
      'select action from audit_event where subject_id=$1',
      [id],
    );
    expect(au.rows).toEqual([{ action: 'policy_proposal.submitted' }]);
  });

  it('refuses a protected-core change with the reason and stores nothing', async () => {
    const r = await submit('refuse', {
      ...ok(),
      rule_ids_and_dps_touched: ['FIX-PRIV-1', 'FIX-RIGHTS-1'],
    }).expect(422);
    expect(r.body.error.code).toBe('protected_core');
    expect(r.body.error.message).toContain('constitution I.2');
    expect(r.body.error.fieldErrors['/rule_ids_and_dps_touched']).toContain(
      'FIX-RIGHTS-1',
    );
    expect(await count(accounts.refuse)).toBe(0);
  });

  it('refuses a self-declared protected-core touch', async () => {
    const c = ok();
    c.protected_core_check.touches_protected_core = true;
    const r = await submit('refuse', c).expect(422);
    expect(r.body.error.code).toBe('protected_core');
    expect(await count(accounts.refuse)).toBe(0);
  });

  it('keeps snake_case pointers for schema violations', async () => {
    const c = ok();
    delete c.reason;
    c.stray = 1;
    const r = await submit('refuse', c).expect(400);
    expect(r.body.error.code).toBe('schema_invalid');
    expect(Object.keys(r.body.error.fieldErrors).sort()).toEqual([
      '/reason',
      '/stray',
    ]);
  });

  it('runs the deterministic privacy gate on the text', async () => {
    const c = ok();
    c.reason =
      'Three audit findings show people get found, write to jane.doe@example.com for the list.';
    const r = await submit('refuse', c).expect(400);
    expect(r.body.error.code).toBe('validation_failed');
    expect(Object.keys(r.body.error.fieldErrors)).toEqual(['/reason']);
    expect(await count(accounts.refuse)).toBe(0);
  });

  it('needs a session', async () => {
    await http()
      .post('/v1/policy-proposals')
      .send({ content: ok() })
      .expect(401);
  });

  it('caps proposals per account per period (default 2 in 7 days)', async () => {
    await submit('cap', ok()).expect(201);
    await submit('cap', ok()).expect(201);
    const r = await submit('cap', ok()).expect(429);
    expect(r.body.error.code).toBe('rate_limited');
    expect(await count(accounts.cap)).toBe(2);
  });

  it('serves public reads and the stage filter without a session', async () => {
    const one = await http().get(`/v1/policy-proposals/${id}`).expect(200);
    expect(one.body.id).toBe(id);
    const list = await http()
      .get('/v1/policy-proposals?stage=submitted&limit=50')
      .expect(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(id);
    const none = await http()
      .get('/v1/policy-proposals?stage=full')
      .expect(200);
    expect(none.body.items.map((x: { id: string }) => x.id)).not.toContain(id);
    await http().get('/v1/policy-proposals?stage=nope').expect(400);
    await http().get(`/v1/policy-proposals/${newId()}`).expect(404);
    await http().get('/v1/policy-proposals/not-an-id').expect(404);
  });

  it('pages with a cursor', async () => {
    const p1 = await http().get('/v1/policy-proposals?limit=1').expect(200);
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await http()
      .get(`/v1/policy-proposals?limit=1&cursor=${p1.body.nextCursor}`)
      .expect(200);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
  });
});

describe('maintainer routes', () => {
  let id: string;
  const reports = (id: string, who: string, b: object) =>
    http().post(`/v1/policy-proposals/${id}/reports`).set(as(who)).send(b);
  const stage = (id: string, who: string, to: string, reason?: string) =>
    http()
      .post(`/v1/policy-proposals/${id}/stage`)
      .set(as(who))
      .send({ to, reason });
  const stageOf = async () =>
    (await http().get(`/v1/policy-proposals/${id}`)).body.stage;

  beforeAll(async () => {
    id = (await submit('b', ok()).expect(201)).body.id;
  });

  it('only maintainers attach reports or move stages', async () => {
    await reports(id, 'a', { eval: json('eval.pass.json') }).expect(403);
    await stage(id, 'a', 'eval').expect(403);
    await http()
      .post(`/v1/policy-proposals/${id}/stage`)
      .send({ to: 'eval' })
      .expect(401);
    expect(await stageOf()).toBe('submitted');
  });

  it('rejects an invalid report with snake_case pointers under the report name', async () => {
    const bad = json('replay.ok.json');
    delete bad.totals;
    const r = await reports(id, 'admin', { replay: bad }).expect(400);
    expect(Object.keys(r.body.error.fieldErrors)).toEqual(['/replay/totals']);
    await reports(id, 'admin', {}).expect(400);
  });

  it('refuses illegal transitions and a replay report too early', async () => {
    await stage(id, 'admin', 'canary').expect(409);
    await stage(id, 'admin', 'submitted').expect(409);
    await reports(id, 'admin', { replay: json('replay.ok.json') }).expect(409);
  });

  it('a blocked eval report moves the stage to eval with the reason', async () => {
    const r = await reports(id, 'admin', {
      eval: json('eval.blocked.json'),
      prUrl: 'https://github.com/example/can_policy/pull/1',
    }).expect(200);
    expect(r.body.stage).toBe('eval');
    expect(r.body.prUrl).toBe('https://github.com/example/can_policy/pull/1');
    expect(r.body.blockedReason).toBe('DP-PRIVACY.injection_pass');
    expect(r.body.eval).toEqual([
      { name: 'DP-PRIVACY.recall_harmful', status: 'passed' },
      { name: 'DP-PRIVACY.injection_pass', status: 'did_not_pass' },
    ]);
  });

  it('ratification needs both reports in and unblocked', async () => {
    await stage(id, 'admin', 'replay').expect(200);
    await stage(id, 'admin', 'ratification').expect(409);
    await reports(id, 'admin', { eval: json('eval.pass.json') }).expect(200);
    await reports(id, 'admin', { replay: json('replay.blocked.json') }).expect(
      200,
    );
    expect(await stageOf()).toBe('replay');
    await stage(id, 'admin', 'ratification').expect(409);
    const r = await reports(id, 'admin', {
      replay: json('replay.ok.json'),
    }).expect(200);
    expect(r.body.blockedReason).toBeNull();
    expect(r.body.replay).toEqual({
      verdict: 'ok',
      changed: 14,
      of: 400,
      expected: 11,
      unexpected: 3,
      stricter: 9,
      morePermissive: 5,
    });
  });

  it('a blocked replay at ratification moves back to replay', async () => {
    await stage(id, 'admin', 'ratification', 'checks passed').expect(200);
    expect(await stageOf()).toBe('ratification');
    const r = await reports(id, 'admin', {
      replay: json('replay.blocked.json'),
    }).expect(200);
    expect(r.body.stage).toBe('replay');
    expect(r.body.blockedReason).toBe('unintended flip in a protected tier');
    await reports(id, 'admin', { replay: json('replay.ok.json') }).expect(200);
  });

  it('walks the rollout, writes one event and one audit row per change, and dates the stages', async () => {
    for (const to of ['ratification', 'shadow', 'canary', 'full'])
      await stage(id, 'admin', to).expect(200);
    const r = await http().get(`/v1/policy-proposals/${id}`).expect(200);
    expect(r.body.stage).toBe('full');
    expect(r.body.ratification.panelStatus).toBe('ratified');
    expect(r.body.rollout.map((x: { stage: string }) => x.stage)).toEqual([
      'shadow',
      'canary',
      'full',
    ]);
    await stage(id, 'admin', 'rejected').expect(409);
    const ev = await pool.query(
      "select count(*)::int n from events where object_id=$1 and event_type='policy_proposal.stage_changed'",
      [id],
    );
    const au = await pool.query(
      "select count(*)::int n from audit_event where subject_id=$1 and action='policy_proposal.stage_changed'",
      [id],
    );
    expect(ev.rows[0].n).toBe(au.rows[0].n);
    expect(ev.rows[0].n).toBeGreaterThanOrEqual(8);
  });
});
