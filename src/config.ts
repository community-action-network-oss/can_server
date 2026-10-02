import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

interface PackPin {
  name: string;
  version: string;
  hash: string;
}

function json<T>(raw: string | undefined, fallback: T): T {
  return raw ? (JSON.parse(raw) as T) : fallback;
}

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://can:can@localhost:5433/can',
  nodeId: env.CAN_NODE_ID ?? 'local-dev',
  corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:8081')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  policyPacksDir: env.POLICY_PACKS_DIR ?? 'test/fixtures/policy',
  /** {"<jurisdiction|default>": {name, version, hash}}; the pinned hash is authoritative. */
  policyActive: json<Record<string, PackPin>>(env.POLICY_ACTIVE, {}),
  policyShadow: json<PackPin | null>(env.POLICY_SHADOW, null),
  policyCanary: json<(PackPin & { percent?: number }) | null>(
    env.POLICY_CANARY,
    null,
  ),
  policyCacheTtlSeconds: Number(env.POLICY_CACHE_TTL_SECONDS ?? 3600),
  policyCacheMaxEntries: Number(env.POLICY_CACHE_MAX_ENTRIES ?? 1000),
  smtpUrl: env.SMTP_URL ?? 'smtp://localhost:1025',
};
