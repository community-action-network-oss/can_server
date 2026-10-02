import { createHmac } from 'node:crypto';
import { gt, inArray, lte } from 'drizzle-orm';
import { config } from '../../config.js';
import { newId } from '../../domain/ids.js';
import { draftFingerprint } from '../../db/schema.js';
import type { Db } from '../../db/db.module.js';
import type { Tx } from '../../db/tx.js';
import {
  fingerprint,
  MATCH_THRESHOLD,
  similarity,
  type HashFn,
} from '../domain/fingerprint.js';

export const FINGERPRINT_TTL_DAYS = 90;
export type FingerprintReason = 'rejected' | 'withdrawn';

/** Keyed, truncated to 64 bits: enough for sketch matching, useless for reversing text. */
export const hmacHash =
  (key: Buffer = Buffer.from(config.fingerprintKey, 'base64')): HashFn =>
  (s) =>
    createHmac('sha256', key).update(s).digest('hex').slice(0, 16);

/**
 * Stores sketches only (no text, no account, no problem). Matches are advisory booleans.
 * purgeForPublished is intentionally absent: with no link to a problem there is nothing to
 * purge by id, so rows leave by expiry (purgeExpired) or by content match at publish time
 * (deleteMatching), which satisfies "fingerprint purged" (T04).
 */
export class FingerprintRepo {
  constructor(
    private readonly db: Db | Tx,
    private readonly hash: HashFn = hmacHash(),
  ) {}

  sketch(text: string): string[] {
    return fingerprint(text, this.hash);
  }

  async store(hashes: string[], reason: FingerprintReason, now: Date) {
    if (hashes.length === 0) return;
    await this.db.insert(draftFingerprint).values({
      id: newId(),
      hashes,
      reason,
      createdAt: now,
      expiresAt: new Date(now.getTime() + FINGERPRINT_TTL_DAYS * 86_400_000),
    });
  }

  private async matchingIds(hashes: string[], threshold: number, now: Date) {
    const rows = await this.db
      .select({ id: draftFingerprint.id, hashes: draftFingerprint.hashes })
      .from(draftFingerprint)
      .where(gt(draftFingerprint.expiresAt, now));
    return rows
      .filter((r) => similarity(hashes, r.hashes) >= threshold)
      .map((r) => r.id);
  }

  // ponytail: scans all live rows in app code; add a GIN index on hashes if the table gets large.
  async findSimilar(
    hashes: string[],
    now: Date,
    threshold = MATCH_THRESHOLD,
  ): Promise<boolean> {
    return (await this.matchingIds(hashes, threshold, now)).length > 0;
  }

  async deleteMatching(
    hashes: string[],
    now: Date,
    threshold = MATCH_THRESHOLD,
  ): Promise<number> {
    const ids = await this.matchingIds(hashes, threshold, now);
    if (ids.length === 0) return 0;
    await this.db
      .delete(draftFingerprint)
      .where(inArray(draftFingerprint.id, ids));
    return ids.length;
  }

  async purgeExpired(now: Date): Promise<number> {
    const r = await this.db
      .delete(draftFingerprint)
      .where(lte(draftFingerprint.expiresAt, now))
      .returning({ id: draftFingerprint.id });
    return r.length;
  }
}
