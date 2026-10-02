import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, lte } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import { pseudonymToken } from '../../db/schema.js';
import { newId } from '../../domain/ids.js';
import type { Tx } from '../../db/tx.js';
import type { TokenEntry } from '../app/redaction/redact.js';

export type Exec = Db | Tx;
export const TOKEN_TTL_MS = 60 * 60 * 1000;

/** Separate key from the email one (derived from it, so no new config), so a leak of one does not open the other. */
const deriveKey = (): Buffer =>
  createHmac('sha256', Buffer.from(config.emailEncKey, 'base64'))
    .update('pseudonym-token-v1')
    .digest();

/** AES-256-GCM, iv(12) + tag(16) + ciphertext: the same layout as the email helper, but the text is kept byte for byte (no case folding). */
export function seal(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
export function open(b: Buffer, key: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

/**
 * Token to original mapping, encrypted, operation scoped and expiring (09-u09).
 * Never joined from run tables; the originals leave only through `resolve`, server side.
 */
@Injectable()
export class TokenStore {
  private readonly key = deriveKey();
  constructor(@Inject(DB) private readonly db: Db) {}

  async put(
    exec: Exec,
    operationId: string,
    entries: readonly TokenEntry[],
    now: Date,
    ttlMs = TOKEN_TTL_MS,
  ): Promise<void> {
    if (!entries.length) return;
    await exec.insert(pseudonymToken).values(
      entries.map((e) => ({
        id: newId(),
        operationId,
        kind: e.kind,
        token: e.token,
        ciphertext: seal(e.original, this.key),
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlMs),
      })),
    );
  }

  /** token to original for one operation; expired rows are invisible even before the purge runs. */
  async resolve(operationId: string, now: Date): Promise<Map<string, string>> {
    const rows = await this.db
      .select({
        token: pseudonymToken.token,
        ciphertext: pseudonymToken.ciphertext,
      })
      .from(pseudonymToken)
      .where(
        and(
          eq(pseudonymToken.operationId, operationId),
          gt(pseudonymToken.expiresAt, now),
        ),
      );
    return new Map(rows.map((r) => [r.token, open(r.ciphertext, this.key)]));
  }

  /** The retention job. Returns the number of rows removed. */
  async purgeExpiredTokens(now: Date): Promise<number> {
    const r = await this.db
      .delete(pseudonymToken)
      .where(lte(pseudonymToken.expiresAt, now))
      .returning({ id: pseudonymToken.id });
    return r.length;
  }

  /** Delete one operation's mapping now (run finished, draft withdrawn). */
  async purgeOperation(operationId: string): Promise<number> {
    const r = await this.db
      .delete(pseudonymToken)
      .where(eq(pseudonymToken.operationId, operationId))
      .returning({ id: pseudonymToken.id });
    return r.length;
  }
}
