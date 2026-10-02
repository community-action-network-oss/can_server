import { describe, expect, it } from 'vitest';
import { config, loadConfig } from './config.js';

const key = Buffer.alloc(32, 1).toString('base64');
const prodKeys = {
  NODE_ENV: 'production',
  EMAIL_ENC_KEY: key,
  EMAIL_INDEX_KEY: key,
  FINGERPRINT_KEY: key,
  INVITE_HASH_KEY: key,
};

describe('loadConfig', () => {
  it('production without keys throws naming the variable', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      /EMAIL_ENC_KEY/,
    );
  });

  it('wrong key length throws naming the variable, not the value', () => {
    const bad = Buffer.alloc(8, 7).toString('base64');
    try {
      loadConfig({ ...prodKeys, FINGERPRINT_KEY: bad });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toMatch(/FINGERPRINT_KEY/);
      expect(String(e)).not.toContain(bad);
    }
  });

  it('dev gets dev keys; defaults hold', () => {
    const c = loadConfig({});
    expect(c.emailEncKey).toBeTruthy();
    expect(c.sessionIdleDays).toBe(30);
    expect(c.sessionAbsoluteDays).toBe(90);
    expect(c.codeTtlMinutes).toBe(10);
    expect(c.codeMaxAttempts).toBe(5);
    expect(c.ai).toMatchObject({
      provider: 'fake',
      spendCapMonthlyUsd: 10,
      dataCollection: 'deny',
    });
  });

  it('keeps the policy keys', () => {
    const c = loadConfig({ POLICY_CACHE_TTL_SECONDS: '5' });
    expect(c.policyPacksDir).toBe('test/fixtures/policy-v1');
    expect(c.policyCacheTtlSeconds).toBe(5);
    expect(c.policyActive).toEqual({});
    expect(config.policyActive).toBeTypeOf('object');
  });

  it('openrouter needs a key; anthropic needs its key', () => {
    expect(() => loadConfig({ AI_PROVIDER: 'openrouter' })).toThrow(
      /OPEN_ROUTER_KEY/,
    );
    expect(() => loadConfig({ AI_PROVIDER: 'anthropic' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(
      loadConfig({ AI_PROVIDER: 'openrouter', OPEN_ROUTER_KEY: 'k' }).ai
        .openRouterKey,
    ).toBe('k');
  });

  it('rejects unknown provider and non-positive cap', () => {
    expect(() => loadConfig({ AI_PROVIDER: 'x' })).toThrow(/AI_PROVIDER/);
    expect(() => loadConfig({ AI_SPEND_CAP_MONTHLY_USD: '0' })).toThrow(
      /AI_SPEND_CAP/,
    );
    expect(() => loadConfig({ AI_SPEND_CAP_MONTHLY_USD: '-3' })).toThrow(
      /AI_SPEND_CAP/,
    );
  });

  it('AI_DATA_COLLECTION=allow is refused in production only', () => {
    expect(loadConfig({ AI_DATA_COLLECTION: 'allow' }).ai.dataCollection).toBe(
      'allow',
    );
    expect(() =>
      loadConfig({ ...prodKeys, AI_DATA_COLLECTION: 'allow' }),
    ).toThrow(/AI_DATA_COLLECTION/);
  });

  it('root env fallback fills only unset names, dev only', () => {
    const root = { AI_PROVIDER: 'openrouter', OPEN_ROUTER_KEY: 'secret-root' };
    const c = loadConfig({ AI_PROVIDER: 'fake' }, root);
    expect(c.ai.provider).toBe('fake');
    expect(c.ai.openRouterKey).toBe('secret-root');
    expect(loadConfig({ ...prodKeys }, root).ai.openRouterKey).toBeUndefined();
  });

  it('a key never appears in an error', () => {
    try {
      loadConfig({ AI_PROVIDER: 'nope', OPEN_ROUTER_KEY: 'secret-root' });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain('secret-root');
    }
  });
});
