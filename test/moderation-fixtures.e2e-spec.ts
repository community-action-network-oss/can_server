import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PolicyStore } from '../src/policy/app/policy-store.js';
import { FsPackSource } from '../src/policy/infra/fs-pack-source.js';
import {
  REQUIRED_DPS,
  gateOutcome,
  moderationFixtures,
} from './support/moderation-fixtures.ts';

const fx = moderationFixtures();
const read = (v: string, name: string, p: string) =>
  readFileSync(join(fx.dir, `${name}@${v}`, p), 'utf8');

describe('moderation fixture packs', () => {
  it('the store loads both packs with their pinned, different hashes', async () => {
    const store = new PolicyStore(new FsPackSource(fx.dir));
    const a = await store.load('fiktiva-city', '1.0.0', fx.v1.hash);
    const b = await store.load('fiktiva-city', fx.v2.version, fx.v2.hash);
    expect(a.hash).not.toBe(b.hash);
    expect(b.chain.map((c) => c.name)).toEqual([
      'base',
      'constitution',
      'fiktiva-city',
    ]);
    expect(b.jurisdiction).toBe('fiktiva-city');
    expect(
      JSON.parse(fx.policyActiveEnv('v2').POLICY_ACTIVE).default.hash,
    ).toBe(b.hash);
  });

  it.each(['1.0.0', '1.1.0'])(
    'v%s has every required DP section with a valid schema',
    (v) => {
      for (const dp of REQUIRED_DPS) {
        const base = `decision-points/${dp}`;
        for (const f of ['pack-section.yaml', 'prompt.md', 'schema.json'])
          expect(read(v, 'base', `${base}/${f}`), `${dp}/${f}`).not.toBe('');
        const schema = JSON.parse(read(v, 'base', `${base}/schema.json`));
        expect(schema.additionalProperties, dp).toBe(false);
        expect(schema.required).toEqual(
          expect.arrayContaining(['outcome', 'confidence']),
        );
      }
    },
  );

  it('no Amsterdam content in either pack', () => {
    for (const v of ['1.0.0', '1.1.0'])
      expect(read(v, 'fiktiva-city', 'pack.yaml').toLowerCase()).not.toContain(
        'amsterdam',
      );
  });

  it('v2 differs from v1 only in the documented files', async () => {
    const src = new FsPackSource(fx.dir);
    for (const [name, changed] of Object.entries(fx.v2ChangedFiles)) {
      const a = await src.read(name, '1.0.0');
      const b = await src.read(name, '1.1.0');
      const skip = (p: string) =>
        p === 'manifest.json' || p.startsWith('ratifications/');
      const keys = new Set([...a.keys(), ...b.keys()]);
      const diff = [...keys]
        .filter(
          (p) =>
            !skip(p) &&
            Buffer.compare(
              a.get(p) ?? Buffer.alloc(0),
              b.get(p) ?? Buffer.alloc(0),
            ) !== 0,
        )
        .sort();
      expect(diff, name).toEqual([...changed].sort());
    }
  });

  it('exactly the documented input flips between v1 and v2', () => {
    const { flippingInput: f } = fx;
    const sec = 'decision-points/DP-NAMING/pack-section.yaml';
    expect(gateOutcome(read('1.0.0', 'base', sec), f.fakeModelOutput)).toBe(
      f.expected.v1,
    );
    expect(gateOutcome(read('1.1.0', 'base', sec), f.fakeModelOutput)).toBe(
      f.expected.v2,
    );
    // control: a confident reject stays reject in both
    const sure = { outcome: 'reject', confidence: 0.97 };
    for (const v of ['1.0.0', '1.1.0'])
      expect(gateOutcome(read(v, 'base', sec), sure)).toBe('reject');
  });
});
