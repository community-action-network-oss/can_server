import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { hashToken } from '../src/accounts/infra/crypto.js';
import { config } from '../src/config.js';
import { UuidV7Generator } from '../src/platform/ports.js';
import { clearMailbox } from './support/mailpit.js';

const id = () => new UuidV7Generator().next();
let app: INestApplication;
let pool: pg.Pool;
const http = () => request(app.getHttpServer());

/** An account with a live native session; returns its bearer token. */
async function actor(role: string) {
  const accountId = id();
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into account (id,email_ciphertext,email_hmac,handle,role,created_at,origin_node_id,protocol_version)
     values ($1,$2,$3,$4,$5,now(),'n','0.1.0')`,
    [
      accountId,
      randomBytes(8),
      randomBytes(32),
      `inv-${accountId.slice(-8)}`,
      role,
    ],
  );
  await pool.query(
    `insert into session (id,account_id,token_hash,expires_at,absolute_expires_at,client_kind)
     values ($1,$2,$3,now()+interval '1 day',now()+interval '1 day','native')`,
    [id(), accountId, hashToken(token)],
  );
  return { accountId, auth: `Bearer ${token}` };
}
const issue = (a: { auth: string }, body: object = {}) =>
  http().post('/v1/invites').set('Authorization', a.auth).send(body);

beforeAll(async () => {
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  pool = new pg.Pool({ connectionString: config.databaseUrl });
});
afterAll(async () => {
  await pool.end();
  await app.close();
});

describe('invites', { timeout: 30_000 }, () => {
  it('steward issues once, code is hashed, listed without it, and redeems at signup', async () => {
    const steward = await actor('moderator');
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const res = await issue(steward, { expiresInDays: 3 }).expect(201);
    const { code, expiresAt } = res.body as { code: string; expiresAt: string };
    expect(code).toMatch(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
    const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);

    const logged = [...out.mock.calls, ...err.mock.calls].flat().join('');
    out.mockRestore();
    err.mockRestore();
    expect(logged).not.toContain(code);

    // stored only as a hash; audit has no code
    const row = await pool.query(
      `select id, code_hash from invite where issued_by=$1`,
      [steward.accountId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].code_hash.toString('utf8')).not.toContain(code);
    const audit = await pool.query(
      `select detail::text d from audit_event where action='invite.issued' and actor_id=$1`,
      [steward.accountId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].d).not.toContain(code);

    const list = await http()
      .get('/v1/invites')
      .set('Authorization', steward.auth)
      .expect(200);
    expect(list.body).toEqual([
      {
        id: row.rows[0].id,
        issuedAt: expect.any(String),
        expiresAt,
        redeemed: false,
      },
    ]);
    expect(JSON.stringify(list.body)).not.toContain(code);
    expect(
      Math.abs(Date.parse(list.body[0].issuedAt) - Date.now()),
    ).toBeLessThan(60_000);

    // redeems via the existing signup use case (mail goes to the test SMTP sink)
    await clearMailbox();
    await http()
      .post('/v1/auth/signup')
      .send({
        inviteCode: code,
        email: `inv-${randomBytes(4).toString('hex')}@example.org`,
        ageConfirmed: true,
      })
      .expect(200, { accepted: true });
    const after = await http()
      .get('/v1/invites')
      .set('Authorization', steward.auth)
      .expect(200);
    expect(after.body[0].redeemed).toBe(true);
  });

  it('refuses members and anonymous callers', async () => {
    const member = await actor('member');
    await issue(member).expect(403);
    await http()
      .get('/v1/invites')
      .set('Authorization', member.auth)
      .expect(403);
    await http().post('/v1/invites').send({}).expect(401);
    await http().get('/v1/invites').expect(401);
  });

  it('admin may issue; days outside 1..30 are rejected', async () => {
    const admin = await actor('admin');
    await issue(admin, { expiresInDays: 30 }).expect(201);
    await issue(admin, { expiresInDays: 0 }).expect(400);
    await issue(admin, { expiresInDays: 31 }).expect(400);
  });

  it('an expired invite fails signup generically', async () => {
    const steward = await actor('moderator');
    const { code } = (await issue(steward).expect(201)).body;
    await pool.query(
      `update invite set expires_at = now() - interval '1 minute' where issued_by=$1`,
      [steward.accountId],
    );
    const res = await http()
      .post('/v1/auth/signup')
      .send({
        inviteCode: code,
        email: 'x-exp@example.org',
        ageConfirmed: true,
      })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_invite');
  });

  it('limits a steward to 20 invites per day', async () => {
    const steward = await actor('moderator');
    for (let n = 0; n < 20; n++) await issue(steward).expect(201);
    await issue(steward).expect(429);
  });
});
