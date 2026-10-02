import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { hashSecret } from '../src/accounts/infra/crypto.js';
import { config } from '../src/config.js';
import { UuidV7Generator } from '../src/platform/ports.js';
import { PUBLIC_KEY } from '../src/platform/security/decorators.js';
import {
  clearMailbox,
  extractCode,
  latestMessageTo,
} from './support/mailpit.js';

const id = () => new UuidV7Generator().next();
const inviteKey = Buffer.from(config.inviteHashKey, 'base64');
let app: INestApplication;
let pool: pg.Pool;
let issuer: string;

async function boot() {
  const mod = await Test.createTestingModule({
    imports: [AppModule, DiscoveryModule],
  }).compile();
  const a = mod.createNestApplication();
  configureApp(a);
  await a.init();
  return a;
}
const http = () => request(app.getHttpServer());
const mkEmail = () => `http-${randomBytes(4).toString('hex')}@example.org`;
const newInvite = async () => {
  const code = randomBytes(8).toString('hex');
  await pool.query(
    `insert into invite (id,code_hash,issued_by,expires_at) values ($1,$2,$3,now()+interval '1 day')`,
    [id(), hashSecret(code, inviteKey), issuer],
  );
  return code;
};
const cookies = (res: request.Response) =>
  (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
const cookieVal = (c: string[], name: string) =>
  c.find((x) => x.startsWith(`${name}=`))!.split(';')[0]!;

/** signup then verify; returns the verify response. */
async function signIn(native = false) {
  const email = mkEmail();
  const inviteCode = await newInvite();
  await clearMailbox();
  await http()
    .post('/v1/auth/signup')
    .send({ inviteCode, email, ageConfirmed: true })
    .expect(200, { accepted: true });
  // Other e2e files share Mailpit and may clear it mid-test: ask again if the mail vanished.
  let code = '';
  for (let n = 0; !code; n++) {
    try {
      code = extractCode((await latestMessageTo(email)).Text);
    } catch (e) {
      if (n >= 2) throw e;
      await http().post('/v1/auth/code').send({ email }).expect(200);
    }
  }
  const req = http().post('/v1/auth/verify');
  if (native) req.set('X-CAN-Client', 'native');
  return req.send({ email, code }).expect(200);
}

beforeAll(async () => {
  app = await boot();
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  issuer = id();
  await pool.query(
    `insert into account (id,email_ciphertext,email_hmac,handle,created_at,origin_node_id,protocol_version)
     values ($1,$2,$3,$4,now(),'n','0.1.0')`,
    [issuer, randomBytes(8), randomBytes(32), `issuer-${issuer.slice(-8)}`],
  );
});
afterAll(async () => {
  await pool.end();
  await app.close();
});

describe('auth over http', { timeout: 30_000 }, () => {
  it('cookie flow: flags, me, csrf, regenerate once, logout', async () => {
    const res = await signIn();
    expect(res.body).toMatchObject({ role: 'member' });
    expect(res.body.token).toBeUndefined();
    const set = cookies(res);
    const session = set.find((c) => c.startsWith('can_session='))!;
    const csrf = set.find((c) => c.startsWith('can_csrf='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\/v1/);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(csrf).toMatch(/SameSite=Lax/i);
    expect(csrf).toMatch(/Path=\/;/);
    expect(session).not.toMatch(/Secure/i); // COOKIE_SECURE is off outside production

    const jar = `${cookieVal(set, 'can_session')}; ${cookieVal(set, 'can_csrf')}`;
    const csrfToken = cookieVal(set, 'can_csrf').split('=')[1]!;

    const me = await http().get('/v1/me').set('Cookie', jar).expect(200);
    expect(me.body).toEqual({ handle: res.body.handle, role: 'member' });
    expect(JSON.stringify(me.body)).not.toContain('@');

    // no header, wrong header: 403
    await http()
      .post('/v1/me/handle/regenerate')
      .set('Cookie', jar)
      .expect(403);
    await http()
      .post('/v1/me/handle/regenerate')
      .set('Cookie', jar)
      .set('X-CAN-CSRF', 'nope')
      .expect(403);
    const regen = await http()
      .post('/v1/me/handle/regenerate')
      .set('Cookie', jar)
      .set('X-CAN-CSRF', csrfToken)
      .expect(200);
    expect(regen.body.handle).toBeTruthy();
    // second call: the use case answers 403 not_permitted (not 409)
    const again = await http()
      .post('/v1/me/handle/regenerate')
      .set('Cookie', jar)
      .set('X-CAN-CSRF', csrfToken)
      .expect(403);
    expect(again.body.error.code).toBe('not_permitted');

    await http().post('/v1/auth/logout').set('Cookie', jar).expect(403);
    await http()
      .post('/v1/auth/logout')
      .set('Cookie', jar)
      .set('X-CAN-CSRF', csrfToken)
      .expect(204);
    const gone = await http().get('/v1/me').set('Cookie', jar).expect(401);
    expect(gone.body.error.code).toBe('session_expired');
  });

  it('no session is unauthenticated; non-GET without session is 401, not CSRF', async () => {
    const a = await http().get('/v1/me').expect(401);
    expect(a.body.error.code).toBe('unauthenticated');
    const b = await http().post('/v1/auth/logout').expect(401);
    expect(b.body.error.code).toBe('unauthenticated');
  });

  it('native client gets the token in the body, no cookies, bearer works without CSRF', async () => {
    const res = await signIn(true);
    expect(cookies(res)).toEqual([]);
    expect(res.body.token).toBeTruthy();
    const auth = `Bearer ${res.body.token}`;
    await http().get('/v1/me').set('Authorization', auth).expect(200);
    await http().post('/v1/auth/logout').set('Authorization', auth).expect(204);
    await http().get('/v1/me').set('Authorization', auth).expect(401);
  });

  it('wrong code is 400 invalid_code in the envelope; requestCode is generic', async () => {
    const r = await http()
      .post('/v1/auth/verify')
      .send({ email: mkEmail(), code: '000000' })
      .expect(400);
    expect(r.body.error.code).toBe('invalid_code');
    const c = await http()
      .post('/v1/auth/code')
      .send({ email: mkEmail() })
      .expect(200);
    expect(c.body).toEqual({
      message: 'If that address can sign in, we sent a code',
    });
  });

  it('route table: only the three exchange routes are public non-GET', () => {
    const publicWrites: string[] = [];
    for (const w of app.get(DiscoveryService).getControllers()) {
      const proto = w.metatype?.prototype as
        Record<string, unknown> | undefined;
      if (!proto) continue;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = proto[name];
        if (typeof fn !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, fn);
        if (method === undefined || method === RequestMethod.GET) continue;
        const pub =
          Reflect.getMetadata(PUBLIC_KEY, fn) ??
          Reflect.getMetadata(PUBLIC_KEY, w.metatype!);
        if (pub) publicWrites.push(name);
      }
    }
    expect(publicWrites.sort()).toEqual([
      'requestCode',
      'signUp',
      'verifyCode',
    ]);
  });

  it('rate limit: 6th request for one email is 429 with Retry-After and envelope', async () => {
    const email = mkEmail();
    for (let i = 0; i < 5; i++)
      await http().post('/v1/auth/code').send({ email }).expect(200);
    const r = await http().post('/v1/auth/code').send({ email }).expect(429);
    expect(r.body.error.code).toBe('rate_limited');
    expect(r.headers['retry-after']).toBe('600');
  });

  it('openapi: no response schema has an email property', async () => {
    const { buildDocument } = await import('../src/app.setup.js');
    const doc = buildDocument(app);
    const requests = new Set(['SignUpDto', 'RequestCodeDto', 'VerifyDto']);
    for (const [name, s] of Object.entries(doc.components?.schemas ?? {})) {
      if (requests.has(name)) continue;
      expect(
        Object.keys((s as { properties?: object }).properties ?? {}),
      ).not.toContain('email');
    }
  });
});
