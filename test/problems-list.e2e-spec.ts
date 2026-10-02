import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { buildDocument, configureApp } from '../src/app.setup.js';
import { config } from '../src/config.js';
import { UuidV7Generator } from '../src/platform/ports.js';

const ids = new UuidV7Generator();
let app: INestApplication;
let pool: pg.Pool;
const tag = `zq${Date.now()}`;
const probs: string[] = [];
const juris: string[] = [];
const hn = JSON.stringify({
  skill_groups: [],
  languages: [],
  coarse_place: null,
  topics: [],
});

const jur = async (name: string, enabled: boolean) => {
  const id = ids.next();
  juris.push(id);
  await pool.query(
    `insert into jurisdiction (id,name,kind,enabled,origin_node_id,protocol_version) values ($1,$2,'city',$3,'n','0.1.0')`,
    [id, name, enabled],
  );
  return id;
};
const prob = async (
  title: string,
  state: string,
  at: string | null,
  j: string,
  extra: { condition?: string; withdrawnPublished?: boolean } = {},
) => {
  const id = ids.next();
  probs.push(id);
  await pool.query(
    `insert into problem (id,title,condition,state,published_at,jurisdiction_id,withdrawn_published,help_needed,origin_node_id,protocol_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'n','0.1.0')`,
    [
      id,
      title,
      extra.condition ?? null,
      state,
      at,
      j,
      !!extra.withdrawnPublished,
      hn,
    ],
  );
  return id;
};
const get = (u: string) => request(app.getHttpServer()).get(u);
const idsOf = (b: { items: { id: string }[] }) => b.items.map((i) => i.id);

let j1: string;
let j2: string;
let a: string, b: string, c: string, d: string;
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  j1 = await jur(`${tag} one`, true);
  j2 = await jur(`${tag} two`, true);
  await jur(`${tag} off`, false);
  a = await prob(`${tag} A`, 'active', '2026-02-01T00:00:00Z', j1, {
    condition: 'broken streetlight outside school',
  });
  b = await prob(`${tag} B`, 'solved', '2026-02-02T00:00:00Z', j1);
  c = await prob(`${tag} C`, 'active', '2026-02-03T00:00:00Z', j2);
  d = await prob(`${tag} D`, 'withdrawn', '2026-02-04T00:00:00Z', j2, {
    withdrawnPublished: true,
  });
  // never public
  for (const s of ['draft', 'in_review', 'needs_revision', 'held', 'rejected'])
    await prob(`${tag} ${s}`, s, '2026-02-05T00:00:00Z', j1);
  await prob(`${tag} unpublished`, 'active', null, j1);
  await prob(`${tag} prewithdrawn`, 'withdrawn', '2026-02-06T00:00:00Z', j1);
});
afterAll(async () => {
  await pool
    .query('delete from problem_event where problem_id = any($1)', [probs])
    .catch(() => 0);
  await pool.query('delete from problem where id = any($1)', [probs]);
  await pool.query('delete from jurisdiction where id = any($1)', [juris]);
  await pool.end();
  await app.close();
});

describe('GET /v1/problems list (02-u10)', () => {
  it('shows only public rows, newest first, with RANK-1 criteria, no sign-in', async () => {
    const res = await get(`/v1/problems?q=${tag}`).expect(200);
    expect(idsOf(res.body)).toEqual([d, c, b, a]);
    expect(res.body.criteria).toEqual({
      order: 'published_at_desc',
      usesEngagementSignals: false,
    });
  });

  it('has an exact item key set with no engagement fields', async () => {
    const res = await get(`/v1/problems?q=${tag}&limit=1`).expect(200);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      [
        'coarseArea',
        'help_needed',
        'id',
        'investigationNeeded',
        'isSeed',
        'jurisdiction',
        'label',
        'policyVersion',
        'publishedAt',
        'reopened',
        'state',
        'syntheticEvidence',
        'title',
        'transitional',
      ].sort(),
    );
  });

  it('labels, joins jurisdiction name, filters by state and jurisdiction', async () => {
    const r = await get(
      `/v1/problems?jurisdictionId=${j1}&state=active`,
    ).expect(200);
    expect(idsOf(r.body)).toEqual([a]);
    expect(r.body.items[0].label).toBe('Active');
    expect(r.body.items[0].jurisdiction).toBe(`${tag} one`);
    await get('/v1/problems?state=draft').expect(400);
  });

  it('q matches title and condition', async () => {
    const r = await get('/v1/problems?q=streetlight').expect(200);
    expect(idsOf(r.body)).toContain(a);
    expect(idsOf(r.body)).not.toContain(b);
  });

  it('pages stably without overlap', async () => {
    const seen: string[] = [];
    let url = `/v1/problems?q=${tag}&limit=3`;
    for (let i = 0; i < 3; i++) {
      const r = await get(url).expect(200);
      seen.push(...idsOf(r.body));
      if (!r.body.nextCursor) break;
      url = `/v1/problems?q=${tag}&limit=3&cursor=${r.body.nextCursor}`;
    }
    expect(seen).toEqual([d, c, b, a]);
  });

  it('OWN-1: no owner or initiator field in OpenAPI problem schemas', () => {
    const schemas = JSON.stringify(buildDocument(app).components?.schemas);
    expect(schemas).not.toMatch(/owner|initiator/i);
  });
});

describe('GET /v1/jurisdictions', () => {
  it('is public and lists enabled jurisdictions only', async () => {
    const r = await get('/v1/jurisdictions').expect(200);
    const mine = r.body.items.filter((x: { name: string }) =>
      x.name.startsWith(tag),
    );
    expect(mine.map((x: { name: string }) => x.name)).toEqual([
      `${tag} one`,
      `${tag} two`,
    ]);
    expect(Object.keys(mine[0]).sort()).toEqual([
      'emergencyNotice',
      'id',
      'isFictional',
      'kind',
      'name',
    ]);
  });
});

describe('problem_event is append-only for can_app_rw', () => {
  it('rejects UPDATE and DELETE', async () => {
    const c0 = await pool.connect();
    const evId = ids.next();
    try {
      await c0.query('begin');
      await c0.query(
        `insert into problem_event (id,problem_id,type,origin_node_id,protocol_version,occurred_at) values ($1,$2,'t','n','0.1.0',now())`,
        [evId, a],
      );
      await c0.query('set local role can_app_rw');
      for (const sql of [
        `update problem_event set type='x'`,
        `delete from problem_event`,
      ]) {
        await c0.query('savepoint s');
        await expect(c0.query(sql)).rejects.toThrow(/permission denied/);
        await c0.query('rollback to s');
      }
    } finally {
      await c0.query('rollback');
      c0.release();
    }
  });
});
