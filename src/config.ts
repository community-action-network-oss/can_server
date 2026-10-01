import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://can:can@localhost:5433/can',
  nodeId: env.CAN_NODE_ID ?? 'local-dev',
  corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:8081')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  smtpUrl: env.SMTP_URL ?? 'smtp://localhost:1025',
};
