import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentSchemaRegistry } from '../../src/policy/app/content-schema-registry.js';
import { PolicyStore } from '../../src/policy/app/policy-store.js';
import { computePackHash } from '../../src/policy/domain/hash.js';
import {
  ContentSchemaNotFound,
  PackRefused,
  PolicyUnavailable,
} from '../../src/policy/domain/pack.js';
import { parseYaml } from '../../src/policy/domain/yaml.js';
import { FsPackSource } from '../../src/policy/infra/fs-pack-source.js';
import { writeFixture } from './build-fixture.ts';
import { FIXTURE_DIR, MemorySource } from './helpers.js';

const pinned = JSON.parse(
  readFileSync(join(process.cwd(), '.env.example'), 'utf8').match(
    /^POLICY_ACTIVE=(.*)$/m,
  )![1],
).default;

async function sealed(
  mutate?: (m: MemorySource) => void,
  opts?: Parameters<MemorySource['reseal']>[0],
) {
  const m = await MemorySource.fixture();
  mutate?.(m);
  const h = m.reseal(opts);
  return { m, h, store: new PolicyStore(m) };
}

describe('policy pack loader', () => {
  it('loads the committed fixture; hash is stable and matches the pin in .env.example', async () => {
    const store = new PolicyStore(new FsPackSource(FIXTURE_DIR));
    const p = await store.load(pinned.name, pinned.version, pinned.hash);
    expect(p.hash).toBe(pinned.hash);
    expect(p.version).toBe(`fiktiva-city@0.0.1+${pinned.hash.slice(0, 12)}`);
    expect(p.chain.map((c) => c.name)).toEqual([
      'base',
      'constitution',
      'fiktiva-city',
    ]);
    // committed manifests are what the independent builder produces
    const tmp = mkdtempSync(join(tmpdir(), 'fixture-'));
    cpSync(FIXTURE_DIR, tmp, { recursive: true });
    const rebuilt = writeFixture(tmp);
    expect(rebuilt['fiktiva-city']).toBe(pinned.hash);
  });

  it('hash ignores CRLF in text files and excluded paths', async () => {
    const m = await MemorySource.fixture();
    const f = m.packs.get('base@0.0.1')!;
    const a = computePackHash(f, null);
    f.set(
      'rules.yaml',
      Buffer.from(m.text('base', 'rules.yaml').replaceAll('\n', '\r\n')),
    );
    f.set('CHANGELOG.md', Buffer.from('x'));
    f.set('.hidden', Buffer.from('x'));
    f.set('ratifications/other.md', Buffer.from('x'));
    expect(computePackHash(f, null)).toBe(a);
    f.set('limits.yaml', Buffer.from('a: 1'));
    expect(computePackHash(f, null)).not.toBe(a);
  });

  it('compiles layers: stricter wins, tier order, limits override', async () => {
    const store = new PolicyStore(new FsPackSource(FIXTURE_DIR));
    const p = await store.load(pinned.name, pinned.version, pinned.hash);
    expect(p.rules.map((r) => r.id)).toEqual([
      'FIX-RIGHTS-1',
      'FIX-CONST-1',
      'FIX-PRIV-1',
      'FIX-CITY-1',
      'FIX-PROC-1',
    ]);
    expect(p.rules.find((r) => r.id === 'FIX-PROC-1')?.enforcement).toBe(
      'reject',
    );
    expect(p.protectedCore).toEqual(['FIX-RIGHTS-1']);
    expect(p.limits).toEqual({
      problem_title_max: 100,
      problem_statement_max: 600,
    });
    expect(Object.isFrozen(p.rules)).toBe(true);
  });

  it('refuses a tampered file and keeps the previous active pack serving', async () => {
    const { m, h, store } = await sealed();
    const good = await store.activate('default', {
      name: 'fiktiva-city',
      version: '0.0.1',
      hash: h['fiktiva-city'],
    });
    m.put(
      'base',
      'limits.yaml',
      m.text('base', 'limits.yaml').replace('120', '121'),
    ); // one byte, not resealed
    const fresh = new PolicyStore(m); // no cache of the good load
    await expect(
      fresh.load('fiktiva-city', '0.0.1', h['fiktiva-city']),
    ).rejects.toThrow(/hash mismatch|manifest/);
    await expect(
      store.activate('default', {
        name: 'base',
        version: '0.0.1',
        hash: 'f'.repeat(64),
      }),
    ).rejects.toThrow(PackRefused);
    expect(store.active('default')).toBe(good);
    expect(store.active('anywhere')).toBe(good);
  });

  it('refuses a stale manifest', async () => {
    const { m, h } = await sealed();
    m.put(
      'fiktiva-city',
      'manifest.json',
      JSON.stringify({ pack_hash: 'a'.repeat(64) }),
    );
    await expect(
      new PolicyStore(m).load('fiktiva-city', '0.0.1', h['fiktiva-city']),
    ).rejects.toThrow(/manifest/);
  });

  it('refuses a missing ratification', async () => {
    const { m, h } = await sealed(undefined, { ratify: false });
    await expect(
      new PolicyStore(m).load('fiktiva-city', '0.0.1', h['fiktiva-city']),
    ).rejects.toThrow(/ratification/);
  });

  it('refuses an expired ratification and one without approved_by', async () => {
    let r = await sealed(undefined, { expiresAt: '2001-01-01' });
    await expect(
      new PolicyStore(r.m).load('fiktiva-city', '0.0.1', r.h['fiktiva-city']),
    ).rejects.toThrow(/expired/);
    r = await sealed(undefined, { approvedBy: '' });
    await expect(
      new PolicyStore(r.m).load('fiktiva-city', '0.0.1', r.h['fiktiva-city']),
    ).rejects.toThrow(/ratification/);
  });

  it('refuses a ratification that names a different hash', async () => {
    const { m, h } = await sealed();
    const p = 'ratifications/fiktiva-city-0.0.1.md';
    m.put(
      'fiktiva-city',
      p,
      m.text('fiktiva-city', p).replace(h['fiktiva-city'], '0'.repeat(64)),
    );
    await expect(
      new PolicyStore(m).load('fiktiva-city', '0.0.1', h['fiktiva-city']),
    ).rejects.toThrow(/ratification/);
  });

  it('refuses an overlay that weakens a higher rule', async () => {
    const { m, h } = await sealed((m) =>
      m.put(
        'fiktiva-city',
        'rules.yaml',
        'rules:\n  - id: FIX-PRIV-1\n    tier: privacy\n    enforcement: advisory\n    text: weaker\n',
      ),
    );
    await expect(
      new PolicyStore(m).load('fiktiva-city', '0.0.1', h['fiktiva-city']),
    ).rejects.toThrow(/weakens/);
  });

  it('refuses an overlay that moves a rule to another tier', async () => {
    const { m, h } = await sealed((m) =>
      m.put(
        'fiktiva-city',
        'rules.yaml',
        'rules:\n  - id: FIX-PROC-1\n    tier: ranking\n    enforcement: hold\n    text: x\n',
      ),
    );
    await expect(
      new PolicyStore(m).load('fiktiva-city', '0.0.1', h['fiktiva-city']),
    ).rejects.toThrow(/tier/);
  });

  it('refuses any touch of a protected_core rule, even a stricter one', async () => {
    const { m, h } = await sealed((m) =>
      m.put(
        'fiktiva-city',
        'rules.yaml',
        'rules:\n  - id: FIX-RIGHTS-1\n    tier: rights\n    enforcement: hold\n    text: stricter\n',
      ),
    );
    await expect(
      new PolicyStore(m).load('fiktiva-city', '0.0.1', h['fiktiva-city']),
    ).rejects.toThrow(/protected core/);
  });

  it('refuses a content schema that does not parse', async () => {
    const { m, h } = await sealed((m) =>
      m.put('base', 'content-schemas/problem/schema.json', '{nope'),
    );
    await expect(
      new PolicyStore(m).load('fiktiva-city', '0.0.1', h['fiktiva-city']),
    ).rejects.toThrow(/does not parse/);
  });

  it('refuses a malformed pinned hash', async () => {
    await expect(
      new PolicyStore(new FsPackSource(FIXTURE_DIR)).load(
        'base',
        '0.0.1',
        'abc',
      ),
    ).rejects.toThrow(PackRefused);
  });

  it('rejects path traversal in pack names', async () => {
    await expect(
      new FsPackSource(FIXTURE_DIR).read('../x', '0.0.1'),
    ).rejects.toThrow(PackRefused);
  });

  it('PolicyUnavailable when nothing valid is active', () => {
    expect(() => new PolicyStore(new MemorySource()).active('default')).toThrow(
      PolicyUnavailable,
    );
  });

  it('keeps shadow and canary slots, and old versions stay loadable by version string', async () => {
    const store = new PolicyStore(new FsPackSource(FIXTURE_DIR));
    const p = await store.activate('default', pinned);
    await store.setShadow(pinned);
    await store.setCanary(pinned, 250);
    expect(store.shadow()).toBe(p);
    expect(store.canary()).toEqual({ pack: p, percent: 100 });
    expect(store.findByVersion(p.version)).toBe(p);
  });
});

describe('content schema registry', () => {
  it('serves schema by type, with messages and hashes', async () => {
    const store = new PolicyStore(new FsPackSource(FIXTURE_DIR));
    await store.activate('default', pinned);
    const reg = new ContentSchemaRegistry(store);
    const r = reg.get('problem', { jurisdiction: 'fiktiva-city' });
    expect(r.schema_id).toBe('fixture.problem');
    expect(r.schema_version).toBe('1.0.0');
    expect(r.schema_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.policy_version).toContain('fiktiva-city@0.0.1+');
    expect(r.messages['schema.problem.title.label']).toBe('Title');
    expect(reg.get('problem', { version: r.policy_version }).schema_hash).toBe(
      r.schema_hash,
    );
  });

  it('typed not-found for unknown type or version; unavailable without a pack', async () => {
    const store = new PolicyStore(new FsPackSource(FIXTURE_DIR));
    expect(() => new ContentSchemaRegistry(store).get('problem')).toThrow(
      PolicyUnavailable,
    );
    await store.activate('default', pinned);
    const reg = new ContentSchemaRegistry(store);
    expect(() => reg.get('nope')).toThrow(ContentSchemaNotFound);
    expect(() => reg.get('__proto__')).toThrow(ContentSchemaNotFound);
    expect(() =>
      reg.get('problem', { version: 'base@9.9.9+000000000000' }),
    ).toThrow(ContentSchemaNotFound);
  });
});

describe('yaml subset', () => {
  it('parses maps, lists of maps, inline lists, comments', () => {
    expect(
      parseYaml(
        'a: 1 # c\nb: [x, y]\nl:\n  - id: q\n    n: "s # t"\n  - z\nk:\n  - m\n',
      ),
    ).toEqual({
      a: 1,
      b: ['x', 'y'],
      l: [{ id: 'q', n: 's # t' }, 'z'],
      k: ['m'],
    });
  });
});

describe('domain purity', () => {
  it('src/policy/domain imports no Nest, Drizzle, pg or I/O', () => {
    const dir = join(process.cwd(), 'src/policy/domain');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(
        /from '(@nestjs|drizzle|pg|node:(fs|net|http|child_process)|fs)/,
      );
    }
  });
});
