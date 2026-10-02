import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

if (existsSync('.env')) process.loadEnvFile('.env');

type Env = Record<string, string | undefined>;

interface PackPin {
  name: string;
  version: string;
  hash: string;
}

/** dev-only, never use outside local. 32 bytes, base64. */
const DEV_KEY = Buffer.alloc(32, 'dev-only-never-use-outside-local').toString(
  'base64',
);

/** Names the dev-only superproject `../.env` may supply (AI gateway only). */
const ROOT_ENV_NAMES = [
  'AI_PROVIDER',
  'OPEN_ROUTER_KEY',
  'ANTHROPIC_API_KEY',
  'AI_SPEND_CAP_MONTHLY_USD',
  'AI_DATA_COLLECTION',
];

function json<T>(raw: string | undefined, fallback: T): T {
  return raw ? (JSON.parse(raw) as T) : fallback;
}

/** Errors name the variable, never the value. */
function oneOf<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = raw || fallback;
  if (!(allowed as readonly string[]).includes(v))
    throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

function num(name: string, raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  return raw === undefined || raw === '' ? fallback : raw === 'true';
}

/** Only the AI names, only when running outside production, never logged. */
function readRootEnv(path: string): Env {
  if (!existsSync(path)) return {};
  const all = parseEnv(readFileSync(path, 'utf8')) as Env;
  return Object.fromEntries(
    ROOT_ENV_NAMES.filter((n) => all[n]).map((n) => [n, all[n]]),
  );
}

export function loadConfig(source: Env, rootEnv: Env = {}) {
  const nodeEnv = oneOf(
    'NODE_ENV',
    source.NODE_ENV,
    ['development', 'test', 'production'] as const,
    'development',
  );
  const prod = nodeEnv === 'production';
  // Dev only: ../.env fills names that are not already set.
  const env: Env = prod ? source : { ...rootEnv, ...stripEmpty(source) };

  /** 32-byte base64 secret; dev gets a labelled fixed value, prod must set it. */
  const key = (name: string): string => {
    const raw = env[name];
    if (!raw) {
      if (prod) throw new Error(`${name} is required in production`);
      return DEV_KEY;
    }
    if (Buffer.from(raw, 'base64').length !== 32)
      throw new Error(`${name} must be 32 bytes, base64 encoded`);
    return raw;
  };

  const provider = oneOf(
    'AI_PROVIDER',
    env.AI_PROVIDER,
    ['fake', 'openrouter', 'anthropic'] as const,
    'fake',
  );
  const spendCap = num(
    'AI_SPEND_CAP_MONTHLY_USD',
    env.AI_SPEND_CAP_MONTHLY_USD,
    10,
  );
  if (spendCap <= 0)
    throw new Error('AI_SPEND_CAP_MONTHLY_USD must be a positive number');
  if (provider === 'openrouter' && !env.OPEN_ROUTER_KEY)
    throw new Error('OPEN_ROUTER_KEY is required when AI_PROVIDER=openrouter');
  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY)
    throw new Error('ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic');
  const dataCollection = oneOf(
    'AI_DATA_COLLECTION',
    env.AI_DATA_COLLECTION,
    ['deny', 'allow'] as const,
    'deny',
  );
  if (prod && dataCollection === 'allow')
    throw new Error('AI_DATA_COLLECTION=allow is not accepted in production');

  const corsOrigins = (env.CORS_ORIGINS ?? 'http://localhost:8081')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    nodeEnv,
    port: num('PORT', env.PORT, 4000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://can:can@localhost:5433/can',
    nodeId: env.CAN_NODE_ID ?? 'local-dev',
    corsOrigins,
    allowedOrigins: corsOrigins,
    trustProxy: bool(env.TRUST_PROXY, false),
    cookieSecure: bool(env.COOKIE_SECURE, prod),
    emailEncKey: key('EMAIL_ENC_KEY'),
    emailIndexKey: key('EMAIL_INDEX_KEY'),
    fingerprintKey: key('FINGERPRINT_KEY'),
    inviteHashKey: key('INVITE_HASH_KEY'),
    sessionIdleDays: num('SESSION_IDLE_DAYS', env.SESSION_IDLE_DAYS, 30),
    sessionAbsoluteDays: num(
      'SESSION_ABSOLUTE_DAYS',
      env.SESSION_ABSOLUTE_DAYS,
      90,
    ),
    codeTtlMinutes: num('CODE_TTL_MINUTES', env.CODE_TTL_MINUTES, 10),
    codeMaxAttempts: num('CODE_MAX_ATTEMPTS', env.CODE_MAX_ATTEMPTS, 5),
    mailTransport: oneOf(
      'MAIL_TRANSPORT',
      env.MAIL_TRANSPORT,
      ['smtp'] as const,
      'smtp',
    ),
    smtpUrl: env.SMTP_URL ?? 'smtp://localhost:1025',
    ai: {
      provider,
      openRouterKey: env.OPEN_ROUTER_KEY || undefined,
      anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
      spendCapMonthlyUsd: spendCap,
      dataCollection,
    },
    policyPacksDir: env.POLICY_PACKS_DIR ?? 'test/fixtures/policy-v1',
    /** {"<jurisdiction|default>": {name, version, hash}}; the pinned hash is authoritative. */
    policyActive: json<Record<string, PackPin>>(env.POLICY_ACTIVE, {}),
    policyShadow: json<PackPin | null>(env.POLICY_SHADOW, null),
    policyCanary: json<(PackPin & { percent?: number }) | null>(
      env.POLICY_CANARY,
      null,
    ),
    policyCacheTtlSeconds: num(
      'POLICY_CACHE_TTL_SECONDS',
      env.POLICY_CACHE_TTL_SECONDS,
      3600,
    ),
    policyCacheMaxEntries: num(
      'POLICY_CACHE_MAX_ENTRIES',
      env.POLICY_CACHE_MAX_ENTRIES,
      1000,
    ),
  };
}

function stripEmpty(e: Env): Env {
  return Object.fromEntries(
    Object.entries(e).filter(([, v]) => v !== undefined),
  );
}

export const config = loadConfig(
  process.env,
  process.env.NODE_ENV === 'production' ? {} : readRootEnv('../.env'),
);
