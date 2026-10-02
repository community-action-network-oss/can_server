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
const tag = `pd${Date.now()}`;
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
let steward: Awaited<ReturnType<typeof acct>>;

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
  steward = await acct('moderator');
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

describe('GET /v1/problems/:id visibility (02-u11)', () => {
  it('pre-publication states: only the initiator sees them, everyone else gets 404', async () => {
    for (const s of [
      'draft',
      'in_review',
      'needs_revision',
      'held',
      'rejected',
    ]) {
      const id = await prob(s, owner.id, { published: false });
      const mine = await get(`/v1/problems/${id}`, owner.token).expect(200);
      expect(mine.body.state).toBe(s);
      expect(mine.body.label).toBeTruthy();
      await get(`/v1/problems/${id}`).expect(404);
      await get(`/v1/problems/${id}`, other.token).expect(404);
      await get(`/v1/problems/${id}`, steward.token).expect(404);
      await get(`/v1/problems/${id}/events`, steward.token).expect(404);
    }
  });

  it('a never-public withdrawn problem is hidden from outsiders', async () => {
    const id = await prob('withdrawn', owner.id, { published: false });
    await get(`/v1/problems/${id}`).expect(404);
    await get(`/v1/problems/${id}`, owner.token).expect(200);
  });

  it('unknown and malformed ids are 404', async () => {
    await get(`/v1/problems/${ids.next()}`).expect(404);
    await get('/v1/problems/nope').expect(404);
    await get('/v1/problems/nope/events').expect(404);
  });

  it('published problems are public with the exact key set and the initiator handle, never email', async () => {
    const id = await prob('active', owner.id);
    const res = await get(`/v1/problems/${id}`).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'affected',
        'condition',
        'coarseArea',
        'desiredOutcome',
        'duplicateOf',
        'explanation',
        'help_needed',
        'id',
        'authorHandle',
        'investigationNeeded',
        'isSeed',
        'jurisdiction',
        'label',
        'nextAction',
        'observed',
        'pauseReason',
        'policyVersion',
        'publishedAt',
        'reopened',
        'resumeCondition',
        'reviewCount',
        'state',
        'syntheticEvidence',
        'title',
        'tombstone',
        'transitional',
        'uncertain',
      ].sort(),
    );
    expect(res.body.authorHandle).toBe(owner.handle);
    expect(res.body.title).toBe('Secret title');
    expect(res.body.tombstone).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/email|hmac|initiator_?id/i);
    await get(`/v1/problems/${id}`, other.token).expect(200);
  });

  it('a tombstoned published problem returns 200 with null text', async () => {
    const id = await prob('withdrawn', owner.id, { tomb: true, wp: true });
    const res = await get(`/v1/problems/${id}`).expect(200);
    expect(res.body.title).toBeNull();
    expect(res.body.condition).toBeNull();
    expect(res.body.tombstone).toEqual({
      tombstone: true,
      tombstonedAt: '2026-03-05T00:00:00.000Z',
      reason: null,
    });
  });
});

describe('GET /v1/problems/:id/events (02-u11)', () => {
  it('pages oldest first, hides payload and non-public actors', async () => {
    const id = await prob('active', owner.id);
    await ev(id, 'published', '2026-03-01T00:00:00Z', owner.id);
    await ev(id, 'internal_note', '2026-03-02T00:00:00Z', steward.id);
    await ev(id, 'paused', '2026-03-03T00:00:00Z', null);
    const p1 = await get(`/v1/problems/${id}/events?limit=2`).expect(200);
    expect(p1.body.items.map((i: { type: string }) => i.type)).toEqual([
      'published',
      'internal_note',
    ]);
    expect(Object.keys(p1.body.items[0]).sort()).toEqual(
      [
        'actor',
        'fromState',
        'id',
        'occurredAt',
        'reason',
        'toState',
        'type',
      ].sort(),
    );
    expect(p1.body.items[0].actor).toBe(owner.handle);
    expect(p1.body.items[1].actor).toBeNull();
    const p2 = await get(
      `/v1/problems/${id}/events?limit=2&cursor=${p1.body.nextCursor}`,
    ).expect(200);
    expect(p2.body.items.map((i: { type: string }) => i.type)).toEqual([
      'paused',
    ]);
    expect(p2.body.nextCursor).toBeNull();
    await get(`/v1/problems/${id}/events?cursor=!!`).expect(400);
  });

  it('hides event reasons once tombstoned', async () => {
    const id = await prob('withdrawn', owner.id, { tomb: true, wp: true });
    await ev(id, 'withdrawn', '2026-03-04T00:00:00Z', owner.id);
    const res = await get(`/v1/problems/${id}/events`).expect(200);
    expect(res.body.items[0].reason).toBeNull();
  });
});
