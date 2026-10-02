import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  decryptEmail,
  emailBlindIndex,
  encryptEmail,
  hashSecret,
  hashToken,
  newLoginCode,
  newToken,
} from './crypto.js';

const k1 = Buffer.alloc(32, 1);
const k2 = Buffer.alloc(32, 2);

describe('email crypto', () => {
  it('round trips, normalising', () => {
    expect(decryptEmail(encryptEmail('  Ann@Example.COM ', k1), k1)).toBe(
      'ann@example.com',
    );
  });
  it('fails on any tampered byte', () => {
    const b = encryptEmail('a@b.co', k1);
    for (const i of [0, 12, 28, b.length - 1]) {
      const t = Buffer.from(b);
      t[i] ^= 1;
      expect(() => decryptEmail(t, k1)).toThrow();
    }
  });
  it('fails with the wrong key', () => {
    expect(() => decryptEmail(encryptEmail('a@b.co', k1), k2)).toThrow();
  });
  it('uses a random iv', () => {
    expect(encryptEmail('a@b.co', k1).equals(encryptEmail('a@b.co', k1))).toBe(
      false,
    );
  });
  it('blind index is stable, case-insensitive and key-dependent', () => {
    const a = emailBlindIndex('A@b.co ', k1);
    expect(a.equals(emailBlindIndex('a@b.co', k1))).toBe(true);
    expect(a.equals(emailBlindIndex('a@b.co', k2))).toBe(false);
  });
});

describe('secrets', () => {
  it('login codes are always 6 digits', () => {
    for (let i = 0; i < 1000; i++) expect(newLoginCode()).toMatch(/^\d{6}$/);
  });
  it('tokens are url-safe and unique', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(t);
  });
  it('hashes are deterministic and keyed', () => {
    expect(hashSecret('123456', k1).equals(hashSecret('123456', k1))).toBe(
      true,
    );
    expect(hashSecret('123456', k1).equals(hashSecret('123456', k2))).toBe(
      false,
    );
    expect(hashToken('x').length).toBe(32);
  });
  it('constantTimeEqual handles unequal lengths', () => {
    expect(constantTimeEqual(Buffer.from('ab'), Buffer.from('abc'))).toBe(
      false,
    );
    expect(constantTimeEqual(Buffer.from('ab'), Buffer.from('ab'))).toBe(true);
  });
});
