import type { AuditInput } from '../../platform/audit/audit.service.js';

export interface AccountRow {
  id: string;
  handle: string;
  role: string;
  handleRegenerations: number;
}
export interface NewAccount extends AccountRow {
  emailCiphertext: Buffer;
  emailHmac: Buffer;
  ageConfirmedAt: Date;
  createdAt: Date;
}
export interface InviteRow {
  id: string;
  expiresAt: Date;
  redeemedAt: Date | null;
}
export interface LoginCodeRow {
  id: string;
  codeHash: Buffer;
  attempts: number;
}
export interface SessionRow {
  id: string;
  accountId: string;
  role: string;
  handle: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  accountDeleted: boolean;
}
export interface NewSession {
  id: string;
  accountId: string;
  tokenHash: Buffer;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  clientKind: 'web' | 'native';
  lastSeenAt: Date;
}

export interface AccountRepo {
  findByEmailHmac(hmac: Buffer): Promise<AccountRow | null>;
  findById(id: string): Promise<AccountRow | null>;
  /** false when the handle is already taken (unique collision). */
  insert(a: NewAccount): Promise<boolean>;
  /** false when the handle is already taken. */
  setHandle(id: string, handle: string): Promise<boolean>;
}
export interface InviteRepo {
  findByHash(hash: Buffer): Promise<InviteRow | null>;
  /** Atomic: false if someone else redeemed it first. */
  redeem(id: string, accountId: string, now: Date): Promise<boolean>;
}
export interface LoginCodeRepo {
  /** Kills every unconsumed code of the account. */
  invalidateOpen(accountId: string, now: Date): Promise<void>;
  insert(c: {
    id: string;
    accountId: string;
    codeHash: Buffer;
    expiresAt: Date;
  }): Promise<void>;
  /** Newest unconsumed, unexpired code with attempts below max. */
  findActive(
    accountId: string,
    now: Date,
    maxAttempts: number,
  ): Promise<LoginCodeRow | null>;
  /** Returns the attempts count after incrementing. */
  addAttempt(id: string): Promise<number>;
  /** Atomic: false if already consumed (replay). */
  consume(id: string, now: Date): Promise<boolean>;
}
export interface SessionRepo {
  insert(s: NewSession): Promise<void>;
  findByHash(tokenHash: Buffer): Promise<SessionRow | null>;
  touch(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void>;
  revoke(tokenHash: Buffer, now: Date): Promise<void>;
}

export interface Repos {
  accounts: AccountRepo;
  invites: InviteRepo;
  codes: LoginCodeRepo;
  sessions: SessionRepo;
  audit(i: AuditInput): Promise<void>;
}
/** One transaction; everything inside commits or rolls back together. */
export interface UnitOfWork {
  run<T>(fn: (r: Repos) => Promise<T>): Promise<T>;
}
export const UNIT_OF_WORK = Symbol('UnitOfWork');

export interface HasPublishedContent {
  check(accountId: string): Promise<boolean>;
}
export const HAS_PUBLISHED_CONTENT = Symbol('HasPublishedContent');

export interface AuthSettings {
  encKey: Buffer;
  indexKey: Buffer;
  /** Keyed hash for invite codes. */
  inviteKey: Buffer;
  codeTtlMinutes: number;
  codeMaxAttempts: number;
  sessionIdleDays: number;
  sessionAbsoluteDays: number;
  /** Float in [0,1) for handles. */
  rng: () => number;
}
export const AUTH_SETTINGS = Symbol('AuthSettings');
