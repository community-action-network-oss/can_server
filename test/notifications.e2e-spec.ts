import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// IP literal: nodemailer resolves names through real DNS, which hangs offline. Must run before config loads.
vi.hoisted(() => {
  process.env.SMTP_URL = 'smtp://127.0.0.1:1025';
});

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { encryptEmail, hashToken } from '../src/accounts/infra/crypto.js';
import { config } from '../src/config.js';
import { NotificationFanout } from '../src/notifications/notification-fanout.js';
import { UuidV7Generator } from '../src/platform/ports.js';
import { clearMailbox, latestMessageTo } from './support/mailpit.js';

const ids = new UuidV7Generator();
const TITLE = 'zznotifytitle';
const BASE = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const cursor = `n${Date.now()}`;
let app: INestApplication;
let pool: pg.Pool;
let fanout: NotificationFanout;
const probs: string[] = [];
const accts: string[] = [];
const hn = JSON.stringify({
  skill_groups: [],
  languages: [],
  coarse_place: null,
  topics: [],
});

const acct = async () => {
  const id = ids.next();
  accts.push(id);
  const token = randomBytes(16).toString('hex');
  const email = `f-${id}@example.org`;
  await pool.query(
    `insert into account (id,email_ciphertext,email_hmac,handle,role,created_at,origin_node_id,protocol_version)
     values ($1,$2,$3,$4,'member',now(),'n','0.1.0')`,
    [
      id,
      encryptEmail(email, Buffer.from(config.emailEncKey, 'base64')),
      randomBytes(8),
      `nt-${id.slice(-12)}`,
    ],
  );
  await pool.query(
    `insert into session (id,account_id,token_hash,expires_at,absolute_expires_at,client_kind)
     values ($1,$2,$3,now()+interval '1 day',now()+interval '1 day','native')`,
    [ids.next(), id, hashToken(token)],
  );
  return { id, token, email };
};
const prob = async (state = 'active') => {
  const id = ids.next();
  probs.push(id);
  await pool.query(
    `insert into problem (id,title,condition,state,published_at,help_needed,origin_node_id,protocol_version)
     values ($1,$2,'Secret condition',$3,$4,$5,'n','0.1.0')`,
    [id, TITLE, state, state === 'draft' ? null : '2026-03-01T00:00:00Z', hn],
  );
  return id;
};
/** A state change that is already committed; the fan-out reads it afterwards. */
const change = (pid: string, to = 'paused', t = 'T10') =>
  pool.query(
    `insert into problem_event (id,problem_id,type,to_state,payload,origin_node_id,protocol_version,occurred_at)
     values ($1,$2,'state_changed',$3,$4,'n','0.1.0',now())`,
    [ids.next(), pid, to, JSON.stringify({ transitionId: t })],
  );
const tick = () => fanout.tick({ cursor, now: new Date(Date.now() + 60_000) });
const call = (
  m: 'get' | 'post' | 'delete',
  u: string,
  a: { token: string },
  body?: object,
) => {
  const r = request(app.getHttpServer())
    [m](u)
    .set('Authorization', `Bearer ${a.token}`);
  return body ? r.send(body) : r;
};
const follow = (
  a: { token: string },
  problemId: string,
  emailUpdates: boolean,
) => call('post', '/v1/follows', a, { problemId, emailUpdates });
const mine = async (a: { token: string }) =>
  (await call('get', '/v1/me/notifications', a).expect(200)).body.items;
const mailTo = async (address: string) =>
  (
    (await (
      await fetch(
        `${BASE}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
      )
    ).json()) as { messages: unknown[] }
  ).messages.length;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  fanout = app.get(NotificationFanout);
  await tick(); // a new cursor starts at the newest existing event
});
beforeEach(clearMailbox);
afterAll(async () => {
  await pool.query('delete from problem_event where problem_id = any($1)', [
    probs,
  ]);
  await pool.query('delete from problem where id = any($1)', [probs]);
  await pool.query('delete from session where account_id = any($1)', [accts]);
  await pool.query('delete from account where id = any($1)', [accts]);
  await pool.query('delete from relay_cursor where name like $1', [
    `${cursor}%`,
  ]);
  await pool.end();
  await app.close();
});

describe('follows, consent and notifications (04-u07)', () => {
  it('only a public problem can be followed, and signing in is required', async () => {
    const a = await acct();
    const draft = await prob('draft');
    await follow(a, draft, false).expect(404);
    await request(app.getHttpServer())
      .post('/v1/follows')
      .send({ problemId: draft, emailUpdates: false })
      .expect(401);
    await follow(a, 'nope', false).expect(400);
  });

  it('email needs the opt-in: consent row with purpose and time, mail with label only', async () => {
    const a = await acct();
    const p = await prob();
    const r = await follow(a, p, true).expect(201);
    expect(r.body).toMatchObject({
      problemId: p,
      muted: false,
      emailUpdates: true,
    });
    const c = await pool.query(
      'select purpose, granted_at, revoked_at from consent_record where account_id=$1',
      [a.id],
    );
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0].purpose).toBe('problem_updates_email');
    expect(c.rows[0].granted_at).toBeInstanceOf(Date);
    expect(c.rows[0].revoked_at).toBeNull();
    await follow(a, p, true).expect(201); // again: still one row
    expect(
      (
        await pool.query('select 1 from consent_record where account_id=$1', [
          a.id,
        ])
      ).rowCount,
    ).toBe(1);

    await change(p);
    await tick();
    const n = await mine(a);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      kind: 'state_changed',
      label: 'Paused',
      read: false,
      problemTitle: TITLE,
    });
    const m = await latestMessageTo(a.email);
    expect(m.Text).toContain('Paused');
    expect(m.Text).toMatch(/mute it, unfollow it or stop all update emails/);
    expect(m.Text + m.Subject).not.toContain(TITLE);
    expect(m.Text).not.toContain('Secret condition');
    await tick(); // a re-run adds nothing
    expect(await mine(a)).toHaveLength(1);
  });

  it('a follow without email consent gets the in-app item and no mail', async () => {
    const a = await acct();
    const p = await prob();
    await follow(a, p, false).expect(201);
    await change(p);
    await tick();
    expect(await mine(a)).toHaveLength(1);
    expect(await mailTo(a.email)).toBe(0);
    expect(
      (
        await pool.query('select 1 from consent_record where account_id=$1', [
          a.id,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('muted gets nothing, unmuted gets later events, unfollow stops fan-out', async () => {
    const a = await acct();
    const p = await prob();
    await follow(a, p, true).expect(201);
    expect(
      (await call('post', `/v1/follows/${p}/mute`, a).expect(200)).body.muted,
    ).toBe(true);
    await change(p);
    await tick();
    expect(await mine(a)).toHaveLength(0);
    expect(await mailTo(a.email)).toBe(0);
    await call('post', `/v1/follows/${p}/unmute`, a).expect(200);
    await change(p, 'active', 'T11');
    await tick();
    expect(await mine(a)).toHaveLength(1);
    await call('delete', `/v1/follows/${p}`, a).expect(204);
    await change(p);
    await tick();
    expect(await mine(a)).toHaveLength(1);
    await call('post', `/v1/follows/${p}/mute`, a).expect(404);
    expect(
      (await call('get', '/v1/me/follows', a).expect(200)).body.items,
    ).toEqual([]);
  });

  it('revoking consent sets revoked_at and stops mail, but not the in-app list', async () => {
    const a = await acct();
    const p = await prob();
    await follow(a, p, true).expect(201);
    await call('delete', '/v1/me/follows/email-consent', a).expect(204);
    const c = await pool.query(
      'select revoked_at from consent_record where account_id=$1',
      [a.id],
    );
    expect(c.rows[0].revoked_at).toBeInstanceOf(Date);
    const f = await call('get', '/v1/me/follows', a).expect(200);
    expect(f.body.items[0]).toMatchObject({
      problemId: p,
      emailUpdates: false,
    });
    await change(p);
    await tick();
    expect(await mine(a)).toHaveLength(1);
    expect(await mailTo(a.email)).toBe(0);
    await follow(a, p, true).expect(201); // opting in again is a new, explicit row
    expect(
      (
        await pool.query('select 1 from consent_record where account_id=$1', [
          a.id,
        ])
      ).rowCount,
    ).toBe(2);
  });

  it('a problem that is not public, and non-lifecycle events, notify nobody', async () => {
    const a = await acct();
    const p = await prob();
    await follow(a, p, false).expect(201);
    await pool.query("update problem set state='held' where id=$1", [p]);
    await change(p, 'held', 'T08');
    await pool.query(
      `insert into problem_event (id,problem_id,type,payload,origin_node_id,protocol_version,occurred_at)
       values ($1,$2,'contribution.submitted','{}','n','0.1.0',now())`,
      [ids.next(), p],
    );
    await tick();
    expect(await mine(a)).toHaveLength(0);
  });

  it('a fan-out failure leaves the committed change alone and the next tick delivers', async () => {
    const a = await acct();
    const p = await prob();
    await follow(a, p, false).expect(201);
    await change(p);
    const spy = vi
      .spyOn(fanout['cursor'], 'advance')
      .mockRejectedValueOnce(new Error('boom'));
    await expect(tick()).rejects.toThrow('boom');
    spy.mockRestore();
    expect(
      (
        await pool.query(
          'select count(*)::int n from problem_event where problem_id=$1',
          [p],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await pool.query('select state from problem where id=$1', [p])).rows[0]
        .state,
    ).toBe('active');
    await tick();
    expect(await mine(a)).toHaveLength(1);
  });

  it('reads, read-all, paging, ownership and no count or badge fields', async () => {
    const a = await acct();
    const b = await acct();
    const p = await prob();
    await follow(a, p, false).expect(201);
    for (let i = 0; i < 3; i++) await change(p);
    await tick();
    const first = await call('get', '/v1/me/notifications?limit=2', a).expect(
      200,
    );
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const rest = await call(
      'get',
      `/v1/me/notifications?limit=2&cursor=${first.body.nextCursor}`,
      a,
    ).expect(200);
    expect(rest.body.items).toHaveLength(1);
    expect(rest.body.nextCursor).toBeNull();
    const id = first.body.items[0].id;
    await call('post', `/v1/me/notifications/${id}/read`, b).expect(404);
    await call('post', `/v1/me/notifications/${id}/read`, a).expect(204);
    expect(
      (await mine(a)).filter((x: { read: boolean }) => x.read),
    ).toHaveLength(1);
    await call('post', '/v1/me/notifications/read-all', a).expect(204);
    expect((await mine(a)).every((x: { read: boolean }) => x.read)).toBe(true);
    await call('get', '/v1/me/notifications?cursor=%%%', a).expect(400);
    const all = JSON.stringify([
      first.body,
      (await call('get', '/v1/me/follows', a)).body,
    ]);
    expect(all).not.toMatch(/count|unread|badge|total/i);
  });
});
