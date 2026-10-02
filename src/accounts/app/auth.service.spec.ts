import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock, SeqIds } from '../../platform/testing.js';
import type { NotificationPort } from '../../platform/ports/notification.js';
import { hashSecret, hashToken } from '../infra/crypto.js';
import { AuthService } from './auth.service.js';
import type { AuthSettings, Repos, SessionRow } from './ports.js';

const key = (n: number) => Buffer.alloc(32, n);
const settings: AuthSettings = {
  encKey: key(1),
  indexKey: key(2),
  inviteKey: key(3),
  codeTtlMinutes: 10,
  codeMaxAttempts: 5,
  sessionIdleDays: 30,
  sessionAbsoluteDays: 90,
  rng: Math.random,
};
const T0 = new Date('2026-01-01T00:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;

function world() {
  const db = {
    accounts: [] as any[],
    invites: [] as any[],
    codes: [] as any[],
    sessions: [] as any[],
    audit: [] as any[],
  };
  const repos: Repos = {
    accounts: {
      findByEmailHmac: async (h) =>
        db.accounts.find((a) => a.emailHmac.equals(h)) ?? null,
      findById: async (id) => db.accounts.find((a) => a.id === id) ?? null,
      insert: async (a) =>
        db.accounts.some((x) => x.handle === a.handle)
          ? false
          : (db.accounts.push({ ...a }), true),
      setHandle: async (id, handle) => {
        const a = db.accounts.find((x) => x.id === id);
        a.handle = handle;
        a.handleRegenerations++;
        return true;
      },
    },
    invites: {
      findByHash: async (h) =>
        db.invites.find((i) => i.codeHash.equals(h)) ?? null,
      redeem: async (id, _acc, now) => {
        const i = db.invites.find((x) => x.id === id);
        if (i.redeemedAt) return false;
        i.redeemedAt = now;
        return true;
      },
    },
    codes: {
      invalidateOpen: async (acc, now) =>
        db.codes
          .filter((c) => c.accountId === acc && !c.consumedAt)
          .forEach((c) => (c.consumedAt = now)),
      insert: async (c) => void db.codes.push({ ...c, attempts: 0 }),
      findActive: async (acc, now, max) =>
        db.codes
          .filter(
            (c) =>
              c.accountId === acc &&
              !c.consumedAt &&
              c.expiresAt > now &&
              c.attempts < max,
          )
          .at(-1) ?? null,
      addAttempt: async (id) => ++db.codes.find((c) => c.id === id).attempts,
      consume: async (id, now) => {
        const c = db.codes.find((x) => x.id === id);
        if (c.consumedAt) return false;
        c.consumedAt = now;
        return true;
      },
    },
    sessions: {
      insert: async (s) => void db.sessions.push({ ...s, revokedAt: null }),
      findByHash: async (h) => {
        const s = db.sessions.find((x) => x.tokenHash.equals(h));
        if (!s) return null;
        const a = db.accounts.find((x) => x.id === s.accountId);
        return {
          ...s,
          role: a.role,
          handle: a.handle,
          accountDeleted: false,
        } as SessionRow;
      },
      touch: async (id, seen, exp) => {
        Object.assign(
          db.sessions.find((s) => s.id === id),
          {
            lastSeenAt: seen,
            expiresAt: exp,
          },
        );
      },
      revoke: async (h, now) => {
        const s = db.sessions.find((x) => x.tokenHash.equals(h));
        if (s) s.revokedAt = now;
      },
    },
    audit: async (i) => void db.audit.push(i),
  };
  const sent: { to: string; text: string }[] = [];
  const mail: NotificationPort = {
    send: async (m) => void sent.push(m),
  };
  const clock = new FixedClock(T0);
  let published = false;
  const svc = new AuthService(
    { run: (fn) => fn(repos) },
    clock,
    new SeqIds(),
    mail,
    settings,
    { check: async () => published },
  );
  db.invites.push({
    id: 'inv1',
    codeHash: hashSecret('INVITE', settings.inviteKey),
    expiresAt: new Date(T0.getTime() + DAY),
    redeemedAt: null,
  });
  const lastCode = () => /\b(\d{6})\b/.exec(sent.at(-1)!.text)![1]!;
  return {
    db,
    sent,
    clock,
    svc,
    lastCode,
    setPublished: (v: boolean) => (published = v),
  };
}
const signUp = (w: ReturnType<typeof world>, email = 'a@x.org') =>
  w.svc.signUp({ inviteCode: 'INVITE', email, ageConfirmed: true });
const rejects = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toMatchObject({ code });

describe('auth use cases', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => (w = world()));

  it('signup creates account, audit without email, sends code', async () => {
    await signUp(w);
    expect(w.db.accounts).toHaveLength(1);
    expect(w.db.accounts[0].emailCiphertext.toString()).not.toContain('a@x');
    expect(w.db.audit.map((a) => a.action)).toEqual(['account.signup']);
    expect(JSON.stringify(w.db.audit)).not.toContain('a@x.org');
    expect(w.sent).toHaveLength(1);
  });

  it('requires age confirmation with a field error', async () => {
    await expect(
      w.svc.signUp({
        inviteCode: 'INVITE',
        email: 'a@x.org',
        ageConfirmed: false,
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      fieldErrors: { ageConfirmed: expect.any(String) },
    });
  });

  it('invite: unknown, expired and reused all say invalid_invite', async () => {
    await rejects(
      w.svc.signUp({
        inviteCode: 'NOPE',
        email: 'a@x.org',
        ageConfirmed: true,
      }),
      'invalid_invite',
    );
    await signUp(w);
    await rejects(signUp(w, 'b@x.org'), 'invalid_invite');
    const w2 = world();
    w2.clock.set(new Date(T0.getTime() + 2 * DAY));
    await rejects(signUp(w2), 'invalid_invite');
  });

  it('duplicate email creates no second account and keeps the invite', async () => {
    await signUp(w);
    w.db.invites.push({
      id: 'inv2',
      codeHash: hashSecret('SECOND', settings.inviteKey),
      expiresAt: new Date(T0.getTime() + DAY),
      redeemedAt: null,
    });
    const r = await w.svc.signUp({
      inviteCode: 'SECOND',
      email: ' A@X.org ',
      ageConfirmed: true,
    });
    expect(r).toEqual({ accepted: true });
    expect(w.db.accounts).toHaveLength(1);
    expect(w.db.invites[1].redeemedAt).toBeNull();
    expect(w.sent).toHaveLength(2);
  });

  it('requestCode has the same shape for known and unknown emails', async () => {
    await signUp(w);
    const known = await w.svc.requestCode({ email: 'a@x.org' });
    const unknown = await w.svc.requestCode({ email: 'zzz@x.org' });
    expect(known).toEqual(unknown);
    expect(w.sent).toHaveLength(2);
  });

  it('new code invalidates the previous one', async () => {
    await signUp(w);
    const first = w.lastCode();
    await w.svc.requestCode({ email: 'a@x.org' });
    const second = w.lastCode();
    if (first !== second)
      await rejects(
        w.svc.verifyCode({ email: 'a@x.org', code: first }),
        'invalid_code',
      );
    await expect(
      w.svc.verifyCode({ email: 'a@x.org', code: second }),
    ).resolves.toMatchObject({ role: 'member' });
  });

  it('verify returns a session; code cannot be replayed', async () => {
    await signUp(w);
    const code = w.lastCode();
    const out = await w.svc.verifyCode({ email: 'a@x.org', code });
    expect(out.token.length).toBeGreaterThan(20);
    expect(await w.svc.resolveSession(out.token)).toMatchObject({
      handle: out.handle,
    });
    expect(w.db.sessions[0].tokenHash.equals(hashToken(out.token))).toBe(true);
    await rejects(w.svc.verifyCode({ email: 'a@x.org', code }), 'invalid_code');
  });

  it('code expires at 10 minutes', async () => {
    await signUp(w);
    w.clock.set(new Date(T0.getTime() + 10 * MIN));
    await rejects(
      w.svc.verifyCode({ email: 'a@x.org', code: w.lastCode() }),
      'invalid_code',
    );
  });

  it('dies after 5 wrong attempts, even for the right code', async () => {
    await signUp(w);
    const good = w.lastCode();
    const bad = good === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++)
      await rejects(
        w.svc.verifyCode({ email: 'a@x.org', code: bad }),
        'invalid_code',
      );
    await rejects(
      w.svc.verifyCode({ email: 'a@x.org', code: good }),
      'invalid_code',
    );
  });

  it('unknown email fails with the same code', async () => {
    await rejects(
      w.svc.verifyCode({ email: 'q@x.org', code: '123456' }),
      'invalid_code',
    );
  });

  async function login() {
    await signUp(w);
    return w.svc.verifyCode({ email: 'a@x.org', code: w.lastCode() });
  }

  it('session slides idle expiry at most once a minute', async () => {
    const { token } = await login();
    const s = w.db.sessions[0];
    const first = s.expiresAt.getTime();
    w.clock.set(new Date(T0.getTime() + 30_000));
    await w.svc.resolveSession(token);
    expect(s.expiresAt.getTime()).toBe(first);
    w.clock.set(new Date(T0.getTime() + 2 * MIN));
    await w.svc.resolveSession(token);
    expect(s.expiresAt.getTime()).toBe(T0.getTime() + 2 * MIN + 30 * DAY);
  });

  it('idle expiry after 30 days without use', async () => {
    const { token } = await login();
    w.clock.set(new Date(T0.getTime() + 30 * DAY));
    await rejects(w.svc.resolveSession(token), 'session_expired');
  });

  it('absolute expiry at 90 days even when kept alive', async () => {
    const { token } = await login();
    for (let d = 20; d < 90; d += 20) {
      w.clock.set(new Date(T0.getTime() + d * DAY));
      await w.svc.resolveSession(token);
    }
    w.clock.set(new Date(T0.getTime() + 90 * DAY));
    await rejects(w.svc.resolveSession(token), 'session_expired');
  });

  it('logout revokes; unknown token is session_expired', async () => {
    const { token } = await login();
    await w.svc.logout(token);
    await rejects(w.svc.resolveSession(token), 'session_expired');
    await rejects(w.svc.resolveSession('garbage'), 'session_expired');
  });

  it('handle regenerates once only', async () => {
    await login();
    const id = w.db.accounts[0].id;
    const r = await w.svc.regenerateHandle(id);
    expect(w.db.accounts[0].handle).toBe(r.handle);
    expect(w.db.audit.at(-1).action).toBe('account.handle_regenerated');
    await rejects(w.svc.regenerateHandle(id), 'not_permitted');
  });

  it('handle cannot change once content is published', async () => {
    await login();
    w.setPublished(true);
    await rejects(w.svc.regenerateHandle(w.db.accounts[0].id), 'not_permitted');
  });
});
