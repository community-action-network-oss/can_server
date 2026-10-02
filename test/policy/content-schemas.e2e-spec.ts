import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { config } from '../../src/config.js';
import { writeFixture } from './build-fixture.ts';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_DIR } from './helpers.js';

async function boot(
  active: typeof config.policyActive,
): Promise<INestApplication> {
  config.policyActive = active;
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

describe('GET /v1/content-schemas/:type (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fixture-'));
    cpSync(FIXTURE_DIR, tmp, { recursive: true });
    const h = writeFixture(tmp);
    config.policyPacksDir = tmp;
    app = await boot({
      default: {
        name: 'fiktiva-city',
        version: '0.0.1',
        hash: h['fiktiva-city'],
      },
    });
  });
  afterAll(() => app.close());

  it('returns the fixture schema with ETag', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/content-schemas/problem')
      .expect(200);
    expect(res.body.schema_id).toBe('fixture.problem');
    expect(res.body.schema_version).toBe('1.0.0');
    expect(res.body.schema_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.policy_version).toMatch(/^fiktiva-city@0\.0\.1\+/);
    expect(res.body.messages['schema.problem.title.label']).toBe('Title');
    expect(res.headers.etag).toBe(`"${res.body.schema_hash}"`);
    expect(res.headers['cache-control']).toBe('no-cache');
    await request(app.getHttpServer())
      .get('/v1/content-schemas/problem')
      .set('If-None-Match', res.headers.etag)
      .expect(304);
    await request(app.getHttpServer())
      .get('/v1/content-schemas/problem')
      .query({ version: res.body.policy_version, jurisdiction: 'fiktiva-city' })
      .expect(200);
  });

  it('404 with the error envelope for an unknown type or version', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/content-schemas/nope')
      .expect(404);
    expect(res.body.error.code).toBe('not_found');
    await request(app.getHttpServer())
      .get('/v1/content-schemas/problem')
      .query({ version: 'x@1.0.0+0' })
      .expect(404);
  });

  it('503 policy_unavailable when no pack is valid', async () => {
    const bad = await boot({
      default: { name: 'base', version: '0.0.1', hash: 'f'.repeat(64) },
    });
    const res = await request(bad.getHttpServer())
      .get('/v1/content-schemas/problem')
      .expect(503);
    expect(res.body.error.code).toBe('policy_unavailable');
    await bad.close();
  });
});
