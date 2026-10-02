import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  REQUIRE_ROLE_KEY,
  RequireRole,
  RoleService,
} from '../src/accounts/app/roles.js';
import { hashToken } from '../src/accounts/infra/crypto.js';
import { config } from '../src/config.js';
import { UuidV7Generator } from '../src/platform/ports.js';
import { Authenticated } from '../src/platform/security/decorators.js';

@Controller('v1/test-roles')
class GuardedController {
  @Get('auditor')
  @Authenticated()
  @RequireRole('auditor')
  auditor() {
    return { ok: true };
  }
  @Get('labeler')
  @Authenticated()
  @RequireRole('labeler')
  labeler() {
    return { ok: true };
  }
  @Get('lane')
  @Authenticated()
  @RequireRole('lane_member')
  lane() {
    return { ok: true };
  }
}
@Module({ imports: [DiscoveryModule], controllers: [GuardedController] })
class GuardedModule {}

const id = () => new UuidV7Generator().next();
let app: INestApplication;
let pool: pg.Pool;
let roles: RoleService;
const http = () => request(app.getHttpServer());

async function actor(role = 'member') {
  const accountId = id();
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into account (id,email_ciphertext,email_hmac,handle,role,created_at,origin_node_id,protocol_version)
     values ($1,$2,$3,$4,$5,now(),'n','0.1.0')`,
    [
      accountId,
      randomBytes(8),
      randomBytes(32),
      `rl-${accountId.slice(-8)}`,
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
const get = (a: { auth: string }, path: string) =>
  http().get(path).set('Authorization', a.auth);

beforeAll(async () => {
  const mod = await Test.createTestingModule({
    imports: [AppModule, GuardedModule],
  }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  roles = app.get(RoleService, { strict: false });
  pool = new pg.Pool({ connectionString: config.databaseUrl });
});
afterAll(async () => {
  await pool.end();
  await app.close();
});

describe('human roles', { timeout: 30_000 }, () => {
  it('allows the matching role and denies members and other roles with 403 not_permitted', async () => {
    const member = await actor();
    const aud = await actor();
    await roles.grantRole(aud.accountId, 'auditor', null);

    await get(aud, '/v1/test-roles/auditor').expect(200);
    const denied = await get(member, '/v1/test-roles/auditor').expect(403);
    expect(denied.body.error.code).toBe('not_permitted');
    expect(denied.body.error.message).toContain('auditor');
    await get(aud, '/v1/test-roles/labeler').expect(403);
    await get(aud, '/v1/test-roles/lane').expect(403);
    await http().get('/v1/test-roles/auditor').expect(401);

    const lab = await actor();
    await roles.grantRole(lab.accountId, 'labeler', null);
    await get(lab, '/v1/test-roles/labeler').expect(200);
    const lane = await actor();
    await roles.grantRole(lane.accountId, 'lane_member', null);
    await get(lane, '/v1/test-roles/lane').expect(200);
  });

  it('writes audit events on grant and revoke, and a revoked role is denied', async () => {
    const a = await actor();
    await roles.grantRole(a.accountId, 'auditor', null);
    await get(a, '/v1/test-roles/auditor').expect(200);
    await roles.revokeRole(a.accountId, 'auditor', null);
    await get(a, '/v1/test-roles/auditor').expect(403);
    const ev = await pool.query(
      `select action, detail from audit_event where subject_id=$1 order by at`,
      [a.accountId],
    );
    expect(ev.rows.map((r) => r.action)).toEqual([
      'account.role.granted',
      'account.role.revoked',
    ]);
    expect(ev.rows[0].detail).toEqual({ role: 'auditor' });
    // can be granted again after revocation; a live duplicate is refused
    await roles.grantRole(a.accountId, 'auditor', null);
    await expect(
      roles.grantRole(a.accountId, 'auditor', null),
    ).rejects.toThrow();
  });

  it('only an admin can grant through the service, and nobody via HTTP', async () => {
    const member = await actor();
    const target = await actor();
    await expect(
      roles.grantRole(target.accountId, 'labeler', member.accountId),
    ).rejects.toMatchObject({ status: 403 });
    const admin = await actor('admin');
    await roles.grantRole(target.accountId, 'labeler', admin.accountId);
    await http()
      .post('/v1/me/roles')
      .set('Authorization', member.auth)
      .send({ role: 'auditor' })
      .expect(404);
  });

  it('exposes my roles; steward is implied by moderator and admin', async () => {
    const mod = await actor('moderator');
    const res = await get(mod, '/v1/me/roles').expect(200);
    expect(res.body).toEqual({ roles: ['steward'] });
    const m = await actor();
    await roles.grantRole(m.accountId, 'lane_member', null);
    await roles.grantRole(m.accountId, 'auditor', null);
    expect((await get(m, '/v1/me/roles').expect(200)).body).toEqual({
      roles: ['auditor', 'lane_member'],
    });
    await get({ auth: 'Bearer nope' }, '/v1/me/roles').expect(401);
  });

  it('no guarded route is a publish, reject or override route', () => {
    const disco = app.get(DiscoveryService, { strict: false });
    const guarded: string[] = [];
    for (const w of disco.getControllers()) {
      const inst = w.instance as object | null;
      if (!inst) continue;
      const proto = Object.getPrototypeOf(inst) as object;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = (proto as Record<string, unknown>)[name];
        if (
          typeof fn === 'function' &&
          Reflect.getMetadata(REQUIRE_ROLE_KEY, fn)
        )
          guarded.push(`${inst.constructor.name}.${name}`);
      }
    }
    expect(guarded.length).toBeGreaterThanOrEqual(3);
    for (const g of guarded) expect(g).not.toMatch(/publish|reject|override/i);
  });
});
