// Plan 09 pack fixtures (09-u01). Derived at runtime from the committed can_policy v1.0.0 export
// (test/fixtures/policy-v1, D-82/D-83), so a policy-fixture resync flows through with no hand copies.
// v2 = v1 with every pack bumped to 1.1.0 plus two FIXTURE-ONLY edits (see test/fixtures/moderation/README.md).
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  computePackHash,
  manifestEntries,
  versionString,
} from '../../src/policy/domain/hash.js';
import { parseYaml } from '../../src/policy/domain/yaml.js';
import { ratificationText } from '../policy/build-fixture.ts';
import { ratifiedV1 } from '../policy/helpers.ts';

export const PACK_NAMES = ['base', 'constitution', 'fiktiva-city'] as const;
/** The ten DP sections the unit requires (a subset of what can_policy ships). */
export const REQUIRED_DPS = [
  'DP-CRISIS',
  'DP-LEGAL',
  'DP-ELIGIBILITY',
  'DP-PRIVACY',
  'DP-NAMING',
  'DP-TONE',
  'DP-FRAMING',
  'DP-ASSUMPTIONS',
  'DP-COMPLETENESS',
  'DP-APPEAL',
] as const;
export const V2_VERSION = '1.1.0';

/** Fixture-only borderline office-alias input: the model is 0.88 sure it is publishable. */
export const FLIPPING_INPUT = {
  id: 'mod-fixture-flip-01',
  dp: 'DP-NAMING',
  text: 'condition: The Ward Clerk of Birch Quarter did not answer the permit query for six weeks\naffected: shopkeepers\ndesired_outcome: a reply within ten days',
  fakeModelOutput: { outcome: 'publish', rule_ids: [], confidence: 0.88 },
  expected: { v1: 'hold', v2: 'publish' },
} as const;

export interface PackFixture {
  version: string;
  hashes: Record<string, string>; // by pack name
  hash: string; // fiktiva-city, the active leaf
}
export interface ModerationFixtures {
  dir: string; // holds <name>@1.0.0 and <name>@1.1.0
  v1: PackFixture;
  v2: PackFixture;
  flippingInput: typeof FLIPPING_INPUT;
  /** Files that differ between v1 and v2, per pack, excluding manifest and ratifications. */
  v2ChangedFiles: Record<string, string[]>;
  policyActiveEnv(v: 'v1' | 'v2'): {
    POLICY_ACTIVE: string;
    POLICY_PACKS_DIR: string;
  };
}

const sectionPath = 'decision-points/DP-NAMING/pack-section.yaml';
const thresholdsPath = 'decision-points/DP-NAMING/eval/thresholds.yaml';
const casesPath = 'decision-points/DP-NAMING/examples/cases.json';

function tree(dir: string, rel = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const e of readdirSync(join(dir, rel))) {
    const p = rel ? `${rel}/${e}` : e;
    if (statSync(join(dir, p)).isDirectory())
      tree(dir, p).forEach((v, k) => out.set(k, v));
    else out.set(p, readFileSync(join(dir, p)));
  }
  return out;
}

/** Lower the DP-NAMING publish floor from 0.90 to 0.85 (the one fixture flip). */
const lowerFloor = (s: string) => {
  const t = s.replace(/(publish:\s*)0\.90\b/, '$10.85');
  if (t === s)
    throw new Error(
      'fixture: DP-NAMING publish floor 0.90 not found; policy-v1 changed',
    );
  return t;
};

function buildV2(dir: string): PackFixture {
  const hashes: Record<string, string> = {};
  let parent: { name: string; hash: string } | null = null;
  for (const name of PACK_NAMES) {
    const src = join(dir, `${name}@1.0.0`);
    const dst = join(dir, `${name}@${V2_VERSION}`);
    cpSync(src, dst, { recursive: true });
    const edit = (p: string, f: (s: string) => string) =>
      writeFileSync(join(dst, p), f(readFileSync(join(dst, p), 'utf8')));
    edit('pack.yaml', (s) =>
      s
        .replace(/^version: 1\.0\.0$/m, `version: ${V2_VERSION}`)
        .replace(/^parent: (\S+)@1\.0\.0$/m, `parent: $1@${V2_VERSION}`),
    );
    if (name === 'base') {
      edit(sectionPath, lowerFloor);
      edit(thresholdsPath, lowerFloor);
      edit(casesPath, (s) => {
        const cases = JSON.parse(s) as Record<string, unknown>[];
        cases.push({
          id: 'ex-NAME-FIXTURE-V2',
          input: FLIPPING_INPUT.text,
          expected_outcome: 'publish',
          rule_ids: [],
          note: 'FIXTURE-ONLY: borderline office alias added in moderation pack v2',
          provenance: 'fixture',
          jurisdiction: 'fiktiva-city',
          field_ref: { field: 'condition' },
        });
        return JSON.stringify(cases, null, 2) + '\n';
      });
    }
    const files = tree(dst);
    const hash = computePackHash(files, parent?.hash ?? null);
    const old = JSON.parse(readFileSync(join(dst, 'manifest.json'), 'utf8'));
    writeFileSync(
      join(dst, 'manifest.json'),
      JSON.stringify(
        {
          ...old,
          version: V2_VERSION,
          parent: parent && {
            name: parent.name,
            version: V2_VERSION,
            pack_hash: parent.hash,
          },
          files: manifestEntries(files),
          pack_hash: hash,
        },
        null,
        2,
      ) + '\n',
    );
    mkdirSync(join(dst, 'ratifications'), { recursive: true });
    writeFileSync(
      join(dst, 'ratifications', `${name}-${V2_VERSION}.md`),
      ratificationText(versionString(name, V2_VERSION, hash), hash),
    );
    hashes[name] = hash;
    parent = { name, hash };
  }
  return { version: V2_VERSION, hashes, hash: hashes['fiktiva-city'] };
}

let memo: ModerationFixtures | undefined;

/** Builds (once per process) a temp pack dir holding v1 (ratified copy of policy-v1) and v2. */
export function moderationFixtures(): ModerationFixtures {
  if (memo) return memo;
  const { dir, hash } = ratifiedV1();
  const v2 = buildV2(dir);
  const env = (v: 'v1' | 'v2') => ({
    POLICY_PACKS_DIR: dir,
    POLICY_ACTIVE: JSON.stringify({
      default: {
        name: 'fiktiva-city',
        version: v === 'v1' ? '1.0.0' : V2_VERSION,
        hash: v === 'v1' ? hash['fiktiva-city'] : v2.hash,
      },
    }),
  });
  memo = {
    dir,
    v1: { version: '1.0.0', hashes: hash, hash: hash['fiktiva-city'] },
    v2,
    flippingInput: FLIPPING_INPUT,
    v2ChangedFiles: {
      base: [casesPath, sectionPath, thresholdsPath, 'pack.yaml'],
      constitution: ['pack.yaml'],
      'fiktiva-city': ['pack.yaml'],
    },
    policyActiveEnv: env,
  };
  return memo;
}

/** FakeModel-style gate: a model outcome below its DP confidence floor becomes hold. */
export function gateOutcome(
  sectionYaml: string,
  out: { outcome: string; confidence: number },
): string {
  const floors = (
    parseYaml(sectionYaml) as {
      thresholds: { confidence_floor: Record<string, number> };
    }
  ).thresholds.confidence_floor;
  const floor = floors[out.outcome];
  return floor !== undefined && out.confidence < floor ? 'hold' : out.outcome;
}
