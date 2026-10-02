import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

/** Trim, lowercase, NFC. Applied once, before encrypting or indexing. */
export const normaliseEmail = (email: string): string =>
  email.trim().toLowerCase().normalize('NFC');

/** AES-256-GCM; output is iv(12) + tag(16) + ciphertext. Key must be 32 bytes. */
export function encryptEmail(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([
    c.update(normaliseEmail(plain), 'utf8'),
    c.final(),
  ]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/** Throws if the bytes were tampered with (GCM tag mismatch). */
export function decryptEmail(bytes: Buffer, key: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_LEN));
  d.setAuthTag(bytes.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([
    d.update(bytes.subarray(IV_LEN + TAG_LEN)),
    d.final(),
  ]).toString('utf8');
}

/** Deterministic lookup key; case-insensitive because it uses the normalised email. */
export const emailBlindIndex = (plain: string, indexKey: Buffer): Buffer =>
  createHmac('sha256', indexKey).update(normaliseEmail(plain)).digest();

/** Keyed HMAC-SHA256 for low-entropy secrets: invite codes and login codes. */
export const hashSecret = (value: string, key: Buffer): Buffer =>
  createHmac('sha256', key).update(value).digest();

/**
 * Session tokens carry 256 bits of entropy, so brute force is infeasible and
 * plain SHA-256 is enough (no key needed, no rotation burden).
 */
export const hashToken = (token: string): Buffer =>
  createHash('sha256').update(token).digest();

export const newToken = (): string => randomBytes(32).toString('base64url');

export const newLoginCode = (): string =>
  String(randomInt(0, 1_000_000)).padStart(6, '0');

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
