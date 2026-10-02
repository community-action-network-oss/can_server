import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PolicyStore } from '../../src/policy/app/policy-store.js';
import { computePackHash } from '../../src/policy/domain/hash.js';
import { FsPackSource } from '../../src/policy/infra/fs-pack-source.js';
import { FIXTURE_V1_DIR, ratifiedV1 } from './helpers.js';

const pins: Record<string, string> = JSON.parse(
  readFileSync(join(FIXTURE_V1_DIR, 'PINS.json'), 'utf8'),
);
const HELP =
  'hash contract diverged from can_policy: see can_policy README "Hash contract"';

describe('policy-v1 fixture: hash parity with can_policy', () => {
  const src = new FsPackSource(FIXTURE_V1_DIR);

  it.each(Object.keys(pins))(
    '%s manifest hash == server hash == pin',
    async (key) => {
      const [name, semver] = key.split('@');
      const files = await src.read(name, semver);
      const manifest = JSON.parse(
        Buffer.from(files.get('manifest.json')!).toString('utf8'),
      ) as {
        pack_hash: string;
        parent: { name: string; version: string; pack_hash: string } | null;
      };
      const parent = manifest.parent?.pack_hash ?? null;
      const mine = computePackHash(files, parent);
      expect(mine, HELP).toBe(manifest.pack_hash);
      expect(
        mine,
        'PINS.json is stale; run scripts/sync-policy-fixture.mjs',
      ).toBe(pins[key]);
    },
  );

  it('the store loads the pinned fiktiva-city chain', async () => {
    const p = await new PolicyStore(new FsPackSource(ratifiedV1().dir)).load(
      'fiktiva-city',
      '1.0.0',
      pins['fiktiva-city@1.0.0'],
    );
    expect(p.chain.map((c) => c.name)).toEqual([
      'base',
      'constitution',
      'fiktiva-city',
    ]);
  });

  it('.env.example pins the same fiktiva-city hash and dir as the fixture', () => {
    const env = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    const active = JSON.parse(env.match(/^POLICY_ACTIVE=(.*)$/m)![1]).default;
    expect(active).toEqual({
      name: 'fiktiva-city',
      version: '1.0.0',
      hash: pins['fiktiva-city@1.0.0'],
    });
    expect(env).toMatch(/^POLICY_PACKS_DIR=test\/fixtures\/policy-v1$/m);
  });
});
