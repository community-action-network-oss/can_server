import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { buildDocument, configureApp } from './app.setup.js';

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, sortKeys(x)]),
        )
      : v;

// No app.listen and no DB query: the pg pool is lazy.
const app = await NestFactory.create(AppModule, { logger: false });
configureApp(app);
await app.init();
mkdirSync('openapi', { recursive: true });
writeFileSync(
  'openapi/openapi.json',
  JSON.stringify(sortKeys(buildDocument(app)), null, 2) + '\n',
);
await app.close();
