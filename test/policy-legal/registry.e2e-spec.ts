import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { config } from '../../src/config.js';
import * as schema from '../../src/db/schema.js';
import {
  LegalCorpusRefused,
  LegalLayerMissing,
} from '../../src/policy/legal/corpus.js';
import { LegalRegistry } from '../../src/policy/legal/registry.js';
import type { Yaml } from '../../src/policy/domain/yaml.js';
import {
  FIKTIVA_DIRS,
  dirOf,
  edit,
  fiktivaStack,
  reseal,
  tmpCopy,
} from './support.js';
import { join } from 'node:path';

const J = 'fiktiva-city';
const T0 = new Date('2026-10-03T08:00:00Z');
const T1 = new Date('2026-10-04T08:00:00Z');
const T2 = new Date('2026-10-05T08:00:00Z');

let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let pins: Yaml | undefined;
const registry = () =>
  new LegalRegistry(
    db,
    async () => pins,
    () => T2,
  );
const reset = () => db.execute(sql`delete from legal_corpus_version`);
const loadAll = async (r: LegalRegistry, skip?: string) => {
  for (const [l, n] of FIKTIVA_DIRS) {
    if (n === skip) continue;
    await r.activate(await r.register(dirOf(l, n)), T0);
  }
};

beforeAll(() => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  db = drizzle(pool, { schema });
});
afterAll(async () => {
  await reset();
  await pool.end();
});
beforeEach(async () => {
  await reset();
  pins = fiktivaStack();
});

describe('LegalRegistry', () => {
  it('returns six layers for fiktiva, with the index_only L5 flagged', async () => {
    const r = registry();
    await loadAll(r);
    const stack = await r.stackFor(J, T1);
    expect(stack.map((l) => l.layer)).toEqual([
      'L1',
      'L2',
      'L3',
      'L4',
      'L5',
      'L6',
    ]);
    expect(stack.map((l) => l.indexOnly)).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(stack[0].mode).toBe('reference');
    expect(stack[1].corpus?.corpusVersion).toMatch(/^fiktiva-union@0\.1\.0\+/);
  });

  it('holds when a layer corpus is missing, and when no stack is pinned', async () => {
    const r = registry();
    await loadAll(r, 'statutes');
    await expect(r.stackFor(J, T1)).rejects.toThrow(LegalLayerMissing);
    await expect(r.stackFor(J, T1)).rejects.toThrow(/L4/);
    pins = undefined;
    await expect(r.stackFor('nowhere', T1)).rejects.toThrow(LegalLayerMissing);
  });

  it('holds before the first activation and on a hash that differs from the pin', async () => {
    const r = registry();
    await loadAll(r);
    await expect(
      r.stackFor(J, new Date('2026-10-01T00:00:00Z')),
    ).rejects.toThrow(LegalLayerMissing);
    const bad = JSON.parse(JSON.stringify(pins)) as { pack_hash: string }[];
    bad[1].pack_hash = 'a'.repeat(64);
    pins = bad as unknown as Yaml;
    await expect(r.stackFor(J, T1)).rejects.toThrow(/differs from the pin/);
  });

  it('holds on a binding index_only pin without acknowledgement', async () => {
    const r = registry();
    await loadAll(r);
    const p = JSON.parse(JSON.stringify(pins)) as Record<string, unknown>[];
    delete p[4].acknowledged_index_only;
    pins = p as unknown as Yaml;
    await expect(r.stackFor(J, T1)).rejects.toThrow(/acknowledged_index_only/);
  });

  it('serves an explicit not_applicable L5 and nothing else without a corpus', async () => {
    const r = registry();
    await loadAll(r, 'region');
    const p = JSON.parse(JSON.stringify(pins)) as Record<string, unknown>[];
    p[4] = {
      layer: 'L5',
      corpus: null,
      mode: 'not_applicable',
      reason: 'invented: no regions in Fiktiva',
    };
    pins = p as unknown as Yaml;
    expect((await r.stackFor(J, T1))[4]).toMatchObject({
      corpus: null,
      mode: 'not_applicable',
    });
  });

  it('never loads a tampered or provenance-less corpus, and the previous version keeps serving', async () => {
    const r = registry();
    await loadAll(r);
    const before = await r.stackFor(J, T1);
    const tampered = tmpCopy(dirOf('L2-supranational', 'union'));
    edit(join(tampered, 'articles/art-4.md'), (s) =>
      s.replace('No public body', 'Any public body'),
    );
    await expect(r.register(tampered)).rejects.toThrow(LegalCorpusRefused);
    const noProv = tmpCopy(dirOf('L2-supranational', 'union'));
    edit(join(noProv, 'corpus.yaml'), (s) =>
      s.replace(/^official_publisher:.*\n/m, ''),
    );
    await expect(r.register(noProv)).rejects.toThrow(LegalCorpusRefused);
    expect(await r.stackFor(J, T1)).toEqual(before);
    expect(await r.list()).toHaveLength(6);
  });

  it('returns the pinned version for a date: the old one before a new activation, the new one after the pin moves', async () => {
    const r = registry();
    await loadAll(r);
    const v2 = tmpCopy(dirOf('L2-supranational', 'union'));
    edit(join(v2, 'articles/art-4.md'), (s) =>
      s.replace('No public body', 'No city body'),
    );
    const hash2 = await reseal(v2, '0.2.0');
    await r.activate(await r.register(v2, hash2), T2);
    // pin still names 0.1.0, which is no longer the active one: hold
    await expect(r.stackFor(J, T2)).rejects.toThrow(/differs from the pin/);
    // a replay of an earlier date resolves the version active then
    expect((await r.stackFor(J, T1))[1].corpus?.version).toBe('0.1.0');
    // the jurisdiction pack moves its pin
    const p = JSON.parse(JSON.stringify(pins)) as Record<string, unknown>[];
    Object.assign(p[1], { version: '0.2.0', pack_hash: hash2 });
    pins = p as unknown as Yaml;
    expect((await r.stackFor(J, T2))[1].corpus?.version).toBe('0.2.0');
  });
});

describe('GET /v1/legal/corpora', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(() => app.close());

  it('lists versions and hashes and leaks no article text', async () => {
    await reset();
    const r = app.get(LegalRegistry);
    for (const [l, n] of FIKTIVA_DIRS)
      await r.activate(await r.register(dirOf(l, n)), T0);
    const res = await request(app.getHttpServer())
      .get('/v1/legal/corpora')
      .expect(200);
    expect(res.body.corpora).toHaveLength(6);
    expect(Object.keys(res.body.corpora[0]).sort()).toEqual([
      'activated_at',
      'corpus_id',
      'hash',
      'jurisdiction',
      'layer',
      'state',
      'version',
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(
      /INVENTED|Article|source_locator|topic/,
    );
    await reset();
  });
});
