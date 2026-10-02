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
const tag = `r${Date.now()}`;
const mk: string[] = [];

const insert = async (
  title: string,
  state: string,
  at: string,
  place: string | null,
) => {
  const id = ids.next();
  mk.push(id);
  await pool.query(
    `insert into problem (id,title,state,published_at,help_needed,origin_node_id,protocol_version)
     values ($1,$2,$3,$4,$5,'n','0.1.0')`,
    [
      id,
      title,
      state,
      at,
      JSON.stringify({
        skill_groups: ['transport'],
        languages: ['pl'],
        coarse_place: place,
        topics: ['housing'],
      }),
    ],
  );
  return id;
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
});
afterAll(async () => {
  await pool.query('delete from problem where id = any($1)', [mk]);
  await pool.end();
  await app.close();
});

describe('public problems with help_needed', () => {
  it('lists and shows help_needed without sign-in, hides pre-publication states', async () => {
    const a = await insert('A', 'active', '2026-01-01T00:00:00Z', tag);
    await insert('B', 'in_review', '2026-01-02T00:00:00Z', tag);
    const c = await insert('C', 'solved', '2026-01-03T00:00:00Z', tag);
    const res = await request(app.getHttpServer())
      .get(`/v1/problems?region=${tag}`)
      .expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([c, a]);
    expect(res.body.items[0].help_needed).toEqual({
      skill_groups: ['transport'],
      languages: ['pl'],
      coarse_place: tag,
      topics: ['housing'],
    });
    const one = await request(app.getHttpServer())
      .get(`/v1/problems/${a}`)
      .expect(200);
    expect(one.body.help_needed.topics).toEqual(['housing']);
  });

  it('pages by cursor and the region shard excludes other regions', async () => {
    await insert('D', 'active', '2026-01-04T00:00:00Z', 'elsewhere');
    const p1 = await request(app.getHttpServer())
      .get(`/v1/problems?region=${tag}&limit=1`)
      .expect(200);
    expect(p1.body.items).toHaveLength(1);
    const p2 = await request(app.getHttpServer())
      .get(`/v1/problems?region=${tag}&limit=1&cursor=${p1.body.nextCursor}`)
      .expect(200);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
    expect(p2.body.nextCursor).toBeNull();
  });

  it('404s for a pre-publication or unknown problem', async () => {
    const id = await insert('E', 'draft', '2026-01-05T00:00:00Z', tag);
    await request(app.getHttpServer()).get(`/v1/problems/${id}`).expect(404);
    await request(app.getHttpServer()).get('/v1/problems/nope').expect(404);
  });

  it('PROFILE-LOCAL-1: no problem route takes a body or profile input', () => {
    const doc = buildDocument(app);
    const allowed = new Set([
      'cursor',
      'limit',
      'region',
      'id',
      'state',
      'jurisdictionId',
      'q',
    ]);
    let seen = 0;
    for (const [path, ops] of Object.entries(doc.paths)) {
      if (!path.startsWith('/v1/problems')) continue;
      for (const [method, op] of Object.entries(
        ops as Record<
          string,
          { requestBody?: unknown; parameters?: { name: string }[] }
        >,
      )) {
        seen++;
        expect(method).toBe('get');
        expect(op.requestBody).toBeUndefined();
        for (const p of op.parameters ?? []) expect(allowed).toContain(p.name);
      }
    }
    expect(seen).toBe(2);
  });
});
