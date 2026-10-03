import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { hashToken } from '../src/accounts/infra/crypto.js';
import { config } from '../src/config.js';
import { UuidV7Generator } from '../src/platform/ports.js';

const ids = new UuidV7Generator();
let app: INestApplication;
let pool: pg.Pool;
const tag = `dl${Date.now()}`;
const probs: string[] = [];
const accts: string[] = [];
const hn = JSON.stringify({
  skill_groups: [],
  languages: [],
  coarse_place: null,
  topics: [],
});

const acct = async (role = 'member') => {
  const id = ids.next();
  accts.push(id);
  const handle = `${tag}-${accts.length}`;
  const token = randomBytes(16).toString('hex');
  await pool.query(
    `insert into account (id,email_ciphertext,email_hmac,handle,role,created_at,origin_node_id,protocol_version)
     values ($1,$2,$3,$4,$5,now(),'n','0.1.0')`,
    [id, randomBytes(8), randomBytes(8), handle, role],
  );
  await pool.query(
    `insert into session (id,account_id,token_hash,expires_at,absolute_expires_at,client_kind)
     values ($1,$2,$3,now()+interval '1 day',now()+interval '1 day','native')`,
    [ids.next(), id, hashToken(token)],
  );
  return { id, handle, token };
};
const prob = async (
  state: string,
  initiator: string | null,
  o: { published?: boolean; tomb?: boolean; wp?: boolean } = {},
) => {
  const id = ids.next();
  probs.push(id);
  await pool.query(
    `insert into problem (id,title,condition,state,initiator_id,published_at,tombstoned_at,withdrawn_published,help_needed,origin_node_id,protocol_version)
     values ($1,'Secret title','Secret condition',$2,$3,$4,$5,$6,$7,'n','0.1.0')`,
    [
      id,
      state,
      initiator,
      o.published === false ? null : '2026-03-01T00:00:00Z',
      o.tomb ? '2026-03-05T00:00:00Z' : null,
      !!o.wp,
      hn,
    ],
  );
  return id;
};
const ev = (pid: string, type: string, at: string, actor: string | null) =>
  pool.query(
    `insert into problem_event (id,problem_id,type,actor_id,from_state,to_state,reason,payload,origin_node_id,protocol_version,occurred_at)
     values ($1,$2,$3,$4,'draft','active','why','{"x":1}','n','0.1.0',$5)`,
    [ids.next(), pid, type, actor, at],
  );
const get = (u: string, token?: string) => {
  const r = request(app.getHttpServer()).get(u);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

let owner: Awaited<ReturnType<typeof acct>>;
let other: Awaited<ReturnType<typeof acct>>;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  owner = await acct();
  other = await acct();
});
afterAll(async () => {
  await pool.query('delete from problem_event where problem_id = any($1)', [
    probs,
  ]);
  await pool.query('delete from problem where id = any($1)', [probs]);
  await pool.query('delete from session where account_id = any($1)', [accts]);
  await pool.query('delete from account where id = any($1)', [accts]);
  await pool.end();
  await app.close();
});

const link = (
  id: string,
  to: string,
  token = owner.token,
  reason = 'same_problem',
) =>
  request(app.getHttpServer())
    .post(`/v1/drafts/${id}/duplicate`)
    .set('Authorization', `Bearer ${token}`)
    .send({ duplicateOfId: to, reason });
const unlink = (id: string, token = owner.token) =>
  request(app.getHttpServer())
    .delete(`/v1/drafts/${id}/duplicate`)
    .set('Authorization', `Bearer ${token}`);

describe('duplicate_of linking (04-u06)', () => {
  it('links, shows target title and the listing, writes ids-only events, and unlinks', async () => {
    const a = await prob('active', owner.id);
    const b = await prob('active', other.id);
    await link(a, b).expect(200);
    const d = await get(`/v1/problems/${a}`).expect(200);
    expect(d.body.duplicateOf).toBe(b);
    expect(d.body.duplicateOfTitle).toBe('Secret title');
    const t = await get(`/v1/problems/${b}`).expect(200);
    expect(t.body.duplicates.map((x: { id: string }) => x.id)).toEqual([a]);
    expect(JSON.stringify(t.body.duplicates)).not.toContain(owner.handle);
    const { rows } = await pool.query(
      "select reason,payload,to_state from problem_event where problem_id=$1 and type='duplicate_linked'",
      [a],
    );
    expect(rows[0].payload).toEqual({ duplicateOfId: b });
    expect(rows[0].to_state).toBe('active');
    await unlink(a).expect(204);
    expect((await get(`/v1/problems/${a}`)).body.duplicateOf).toBeNull();
    expect((await get(`/v1/problems/${b}`)).body.duplicates).toEqual([]);
    await unlink(a).expect(404);
    const ev = await pool.query(
      "select 1 from problem_event where problem_id=$1 and type='duplicate_unlinked'",
      [a],
    );
    expect(ev.rowCount).toBe(1);
  });

  it('refuses self, cycles, long chains and an unlinkable target', async () => {
    const a = await prob('active', owner.id);
    const b = await prob('active', owner.id);
    const c = await prob('active', owner.id);
    await link(a, a).expect(400);
    await link(a, 'nope').expect(400);
    await link(a, b).expect(200);
    await link(b, c).expect(200);
    await link(c, a).expect(409);
    await link(b, a).expect(409);
    const draft = await prob('draft', owner.id, { published: false });
    const tomb = await prob('withdrawn', other.id, { tomb: true });
    const wd = await prob('withdrawn', other.id, { wp: true });
    for (const t of [draft, tomb, wd, ids.next()]) await link(a, t).expect(404);
    // chain depth
    const chain = [await prob('active', owner.id)];
    for (let i = 0; i < 10; i++) {
      const n = await prob('active', owner.id);
      await link(n, chain[chain.length - 1]!).expect(200);
      chain.push(n);
    }
    await link(await prob('active', owner.id), chain[10]!).expect(409);
  });

  it('a private draft may point at a public problem and stays private', async () => {
    const draft = await prob('draft', owner.id, { published: false });
    const pub = await prob('active', other.id);
    await link(draft, pub).expect(200);
    await get(`/v1/problems/${draft}`).expect(404);
    expect((await get(`/v1/problems/${pub}`)).body.duplicates).toEqual([]);
  });

  it('initiator only, session needed, terminal states locked, validation', async () => {
    const a = await prob('active', owner.id);
    const b = await prob('active', other.id);
    await link(a, b, other.token).expect(404);
    await request(app.getHttpServer())
      .post(`/v1/drafts/${a}/duplicate`)
      .send({ duplicateOfId: b, reason: 'other' })
      .expect(401);
    await unlink(a, other.token).expect(404);
    await link(a, b, owner.token, 'free text').expect(400);
    const closed = await prob('closed', owner.id);
    await link(closed, b).expect(409);
    // the target stays untouched
    const [row] = (
      await pool.query('select state,title from problem where id=$1', [b])
    ).rows;
    expect(row.state).toBe('active');
  });
});
