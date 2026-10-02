import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../platform/errors.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import {
  NOTIFICATION,
  type NotificationPort,
} from '../../platform/ports/notification.js';
import { signInCode } from '../../platform/mail/templates.js';
import {
  constantTimeEqual,
  decryptEmail,
  emailBlindIndex,
  encryptEmail,
  hashSecret,
  hashToken,
  newLoginCode,
  newToken,
  normaliseEmail,
} from '../infra/crypto.js';
import { generateHandle } from '../domain/handle.js';
import {
  AUTH_SETTINGS,
  HAS_PUBLISHED_CONTENT,
  UNIT_OF_WORK,
  type AuthSettings,
  type HasPublishedContent,
  type Repos,
  type UnitOfWork,
} from './ports.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
const HANDLE_TRIES = 5;

/** Same shape for known and unknown emails, so nothing leaks. */
export interface CodeRequested {
  accepted: true;
}

const invalidInvite = () =>
  new ApiException(400, 'invalid_invite', 'This invite is not valid.');
const invalidCode = () =>
  new ApiException(400, 'invalid_code', 'That code is not valid.');
const expired = () =>
  new ApiException(401, 'session_expired', 'Your session has ended.');

@Injectable()
export class AuthService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(NOTIFICATION) private readonly mail: NotificationPort,
    @Inject(AUTH_SETTINGS) private readonly s: AuthSettings,
    @Inject(HAS_PUBLISHED_CONTENT)
    private readonly published: HasPublishedContent,
  ) {}

  async signUp(i: {
    inviteCode: string;
    email: string;
    ageConfirmed: boolean;
  }): Promise<CodeRequested> {
    if (i.ageConfirmed !== true)
      throw new ApiException(400, 'validation_failed', 'Confirm your age.', {
        ageConfirmed: 'You must confirm you are old enough to use CAN.',
      });
    const email = normaliseEmail(i.email);
    const inviteHash = hashSecret(i.inviteCode.trim(), this.s.inviteKey);
    const hmac = emailBlindIndex(email, this.s.indexKey);
    const code = newLoginCode();
    const codeHash = hashSecret(code, this.s.indexKey);
    const now = this.clock.now();
    await this.uow.run(async (r) => {
      const inv = await r.invites.findByHash(inviteHash);
      if (!inv || inv.redeemedAt || inv.expiresAt <= now) throw invalidInvite();
      const existing = await r.accounts.findByEmailHmac(hmac);
      if (existing) return this.issue(r, existing.id, codeHash, now);
      const id = this.ids.next();
      let created = false;
      for (let n = 0; n < HANDLE_TRIES && !created; n++) {
        created = await r.accounts.insert({
          id,
          handle: generateHandle(this.s.rng),
          role: 'member',
          handleRegenerations: 0,
          emailCiphertext: encryptEmail(email, this.s.encKey),
          emailHmac: hmac,
          ageConfirmedAt: now,
          createdAt: now,
        });
      }
      if (!created) throw new Error('could not generate a free handle');
      // Rolls the whole transaction back if another request won the invite.
      if (!(await r.invites.redeem(inv.id, id, now))) throw invalidInvite();
      await r.audit({
        actorId: id,
        action: 'account.signup',
        subjectType: 'account',
        subjectId: id,
        detail: { inviteId: inv.id },
      });
      await this.issue(r, id, codeHash, now);
    });
    this.send(email, code);
    return { accepted: true };
  }

  async requestCode(i: { email: string }): Promise<CodeRequested> {
    const email = normaliseEmail(i.email);
    const hmac = emailBlindIndex(email, this.s.indexKey);
    const code = newLoginCode();
    const codeHash = hashSecret(code, this.s.indexKey); // hashing happens either way
    const now = this.clock.now();
    const known = await this.uow.run(async (r) => {
      const a = await r.accounts.findByEmailHmac(hmac);
      if (a) await this.issue(r, a.id, codeHash, now);
      return !!a;
    });
    // ponytail: unknown emails skip the DB write; timing differs by one insert. Add a dummy write if that matters.
    if (known) this.send(email, code);
    return { accepted: true };
  }

  async verifyCode(i: {
    email: string;
    code: string;
    clientKind?: 'web' | 'native';
  }): Promise<{ token: string; handle: string; role: string }> {
    const hmac = emailBlindIndex(i.email, this.s.indexKey);
    const given = hashSecret(i.code.trim(), this.s.indexKey);
    const now = this.clock.now();
    // Failures return (not throw) so the attempt counter commits.
    const out = await this.uow.run(async (r) => {
      const a = await r.accounts.findByEmailHmac(hmac);
      if (!a) {
        constantTimeEqual(given, given);
        return null;
      }
      const c = await r.codes.findActive(a.id, now, this.s.codeMaxAttempts);
      if (!c) return null;
      await r.codes.addAttempt(c.id);
      if (!constantTimeEqual(c.codeHash, given)) return null;
      if (!(await r.codes.consume(c.id, now))) return null;
      const token = newToken();
      const absolute = new Date(
        now.getTime() + this.s.sessionAbsoluteDays * DAY,
      );
      await r.sessions.insert({
        id: this.ids.next(),
        accountId: a.id,
        tokenHash: hashToken(token),
        expiresAt: this.idleExpiry(now, absolute),
        absoluteExpiresAt: absolute,
        clientKind: i.clientKind ?? 'web',
        lastSeenAt: now,
      });
      return { token, handle: a.handle, role: a.role };
    });
    if (!out) throw invalidCode();
    return out;
  }

  async resolveSession(
    token: string,
  ): Promise<{ accountId: string; role: string; handle: string }> {
    const now = this.clock.now();
    return this.uow.run(async (r) => {
      const s = await r.sessions.findByHash(hashToken(token));
      if (
        !s ||
        s.revokedAt ||
        s.accountDeleted ||
        s.expiresAt <= now ||
        s.absoluteExpiresAt <= now
      )
        throw expired();
      if (!s.lastSeenAt || now.getTime() - s.lastSeenAt.getTime() >= MINUTE)
        await r.sessions.touch(
          s.id,
          now,
          this.idleExpiry(now, s.absoluteExpiresAt),
        );
      return { accountId: s.accountId, role: s.role, handle: s.handle };
    });
  }

  async logout(token: string): Promise<void> {
    const now = this.clock.now();
    await this.uow.run((r) => r.sessions.revoke(hashToken(token), now));
  }

  async regenerateHandle(accountId: string): Promise<{ handle: string }> {
    return this.uow.run(async (r) => {
      const a = await r.accounts.findById(accountId);
      if (!a) throw new ApiException(404, 'not_found', 'Account not found.');
      if (a.handleRegenerations >= 1 || (await this.published.check(accountId)))
        throw new ApiException(
          403,
          'not_permitted',
          'Your handle can no longer be changed.',
        );
      for (let n = 0; n < HANDLE_TRIES; n++) {
        const handle = generateHandle(this.s.rng);
        if (await r.accounts.setHandle(accountId, handle)) {
          await r.audit({
            actorId: accountId,
            action: 'account.handle_regenerated',
            subjectType: 'account',
            subjectId: accountId,
          });
          return { handle };
        }
      }
      throw new Error('could not generate a free handle');
    });
  }

  private idleExpiry(now: Date, absolute: Date): Date {
    const idle = new Date(now.getTime() + this.s.sessionIdleDays * DAY);
    return idle < absolute ? idle : absolute;
  }

  private async issue(
    r: Repos,
    accountId: string,
    codeHash: Buffer,
    now: Date,
  ) {
    await r.codes.invalidateOpen(accountId, now);
    await r.codes.insert({
      id: this.ids.next(),
      accountId,
      codeHash,
      expiresAt: new Date(now.getTime() + this.s.codeTtlMinutes * MINUTE),
    });
  }

  /** After commit, not awaited, so response time does not depend on SMTP. Failures are logged by the adapter. */
  /**
   * The only way other modules reach an address: decrypted here at send time, never returned.
   * False when the account is gone. Rejects with MailSendError when the transport fails.
   */
  async sendToAccount(
    accountId: string,
    msg: { subject: string; text: string; kind: string },
  ): Promise<boolean> {
    const c = await this.uow.run((r) => r.accounts.emailCiphertext(accountId));
    if (!c) return false;
    await this.mail.send({ to: decryptEmail(c, this.s.encKey), ...msg });
    return true;
  }

  private send(to: string, code: string): void {
    const { subject, text } = signInCode(code);
    this.mail.send({ to, subject, text, kind: 'sign_in_code' }).catch(() => {});
  }
}
