import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountsModule } from '../src/accounts/accounts.module.js';
import { AuthService } from '../src/accounts/app/auth.service.js';
import { hashSecret } from '../src/accounts/infra/crypto.js';
import { config } from '../src/config.js';
import { DbModule } from '../src/db/db.module.js';
import { PlatformModule } from '../src/platform/platform.module.js';
import { UuidV7Generator } from '../src/platform/ports.js';
import {
  clearMailbox,
  extractCode,
  latestMessageTo,
} from './support/mailpit.js';

const id = () => new UuidV7Generator().next();
const inviteKey = Buffer.from(config.inviteHashKey, 'base64');
let pool: pg.Pool;
let auth: AuthService;
let close: () => Promise<void>;
let issuer: string;

beforeAll(async () => {
  const mod = await Test.createTestingModule({
    imports: [PlatformModule, DbModule, AccountsModule],
  }).compile();
  const app = mod.createNestApplication();
  await app.init();
  auth = app.get(AuthService);
  close = () => app.close();
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
  await close();
});
beforeEach(clearMailbox);

const newInvite = async () => {
  const code = randomBytes(8).toString('hex');
  await pool.query(
    `insert into invite (id,code_hash,issued_by,expires_at) values ($1,$2,$3,now()+interval '1 day')`,
    [id(), hashSecret(code, inviteKey), issuer],
  );
  return code;
};

describe('auth use cases (real db and mail)', () => {
  it('signup, code from Mailpit, verify, session resolves; audit has no email', async () => {
    const email = `e2e-${randomBytes(4).toString('hex')}@example.org`;
    const inviteCode = await newInvite();
    expect(
      await auth.signUp({ inviteCode, email, ageConfirmed: true }),
    ).toEqual({ accepted: true });
    const code = extractCode((await latestMessageTo(email)).Text);
    const out = await auth.verifyCode({ email, code });
    expect(await auth.resolveSession(out.token)).toMatchObject({
      handle: out.handle,
      role: 'member',
    });

    const { rows } = await pool.query(
      `select detail::text d, actor_id from audit_event where action='account.signup' and actor_id=(select id from account where handle=$1)`,
      [out.handle],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].d).not.toContain(email);

    await expect(auth.verifyCode({ email, code })).rejects.toMatchObject({
      code: 'invalid_code',
    });
    await auth.logout(out.token);
    await expect(auth.resolveSession(out.token)).rejects.toMatchObject({
      code: 'session_expired',
    });
  });

  it('a second signup with the same invite fails generically', async () => {
    const inviteCode = await newInvite();
    const mk = () => `e2e-${randomBytes(4).toString('hex')}@example.org`;
    await auth.signUp({ inviteCode, email: mk(), ageConfirmed: true });
    await expect(
      auth.signUp({ inviteCode, email: mk(), ageConfirmed: true }),
    ).rejects.toMatchObject({ code: 'invalid_invite' });
  });
});
