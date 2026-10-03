import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DATA_DIR,
  SimDataError,
  loadFramings,
  loadPersonas,
  loadSeeds,
  loadThresholds,
} from './load.ts';
import { hashTree } from './hash.ts';

// Attack data holds planted fictional personal data: assert on ids and counts only, never print rows.
const copy = () => {
  const d = mkdtempSync(join(tmpdir(), 'simdata-'));
  cpSync(DATA_DIR, d, { recursive: true });
  return d;
};
const edit = (file: string, f: (s: string) => string) =>
  writeFileSync(file, f(readFileSync(file, 'utf8')));

describe('committed simulation snapshot', () => {
  it('matches SOURCE.json parity (hash and file count)', () => {
    const src = JSON.parse(readFileSync(join(DATA_DIR, 'SOURCE.json'), 'utf8'));
    const { sha256, files } = hashTree(DATA_DIR);
    expect(
      sha256,
      'snapshot edited by hand or stale: run npm run sim:sync',
    ).toBe(src.content_sha256);
    expect(files).toBe(src.files);
    expect(src.can_policy_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('loads personas, all synthetic, every script variant validated', () => {
    const ps = loadPersonas();
    expect(ps.length).toBeGreaterThanOrEqual(10);
    expect(ps.every((p) => p.persona.synthetic === true)).toBe(true);
    expect(
      ps.find((p) => p.persona.id === 'sub-wellmeaning-wrong')!.scripts,
    ).toHaveProperty('script-legal.json');
    const attackers = ps.filter((p) => p.persona.attack_data);
    expect(attackers.length).toBeGreaterThan(0);
    expect(
      attackers.every(
        (p) =>
          p.attacks.length > 0 &&
          new Set(p.attacks.map((a) => a.id)).size === p.attacks.length,
      ),
    ).toBe(true);
  });

  it('loads thresholds G1 to G13 with fake recordings refused', () => {
    const t = loadThresholds();
    expect(t.fake_recordings_satisfy).toBe(false);
    expect(t.forbid_model_id_prefix).toBe('fake-derived-');
    for (let n = 1; n <= 13; n++) expect(t).toHaveProperty(`g${n}`);
  });

  it('loads seeds (none yet is fine) and framings', () => {
    expect(Array.isArray(loadSeeds())).toBe(true);
    expect(Object.keys(loadFramings()).length).toBeGreaterThanOrEqual(4);
  });
});

describe('fail closed', () => {
  let d: string;
  beforeEach(() => {
    d = copy();
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it('refuses a persona without synthetic: true', () => {
    edit(join(d, 'simulation/personas/con-expert/persona.yaml'), (s) =>
      s.replace(/^synthetic: true$/m, 'synthetic: false'),
    );
    expect(() => loadPersonas(d)).toThrow(SimDataError);
  });

  it('refuses a persona whose id differs from its directory', () => {
    edit(join(d, 'simulation/personas/con-expert/persona.yaml'), (s) =>
      s.replace(/^id: .*$/m, 'id: "con-other"'),
    );
    expect(() => loadPersonas(d)).toThrow(/directory name/);
  });

  it('refuses a script that breaks its schema', () => {
    writeFileSync(
      join(d, 'simulation/personas/con-expert/script.json'),
      '{"steps":"nope"}',
    );
    expect(() => loadPersonas(d)).toThrow(/script schema/);
  });

  it('refuses thresholds that let fake recordings count', () => {
    edit(join(d, 'simulation/thresholds.yaml'), (s) =>
      s.replace(
        'fake_recordings_satisfy: false',
        'fake_recordings_satisfy: true',
      ),
    );
    expect(() => loadThresholds(d)).toThrow(SimDataError);
  });

  const seedYaml = (over: Record<string, string> = {}) => {
    const f = {
      id: 'seed-1-test',
      number: '1',
      framing: JSON.stringify(loadFramings(d)['1']),
      personas: '["con-expert"]',
      ...over,
    };
    return `id: "${f.id}"
number: ${f.number}
framing: ${f.framing}
jurisdiction: "amsterdam"
label: "Seed problem, synthetic evidence"
problem: "problem.json"
rubric: "rubric.md"
stage_plan: "stage-plan.json"
evidence:
  - { id: "e1", url: "https://evidence.sim.test/e1", description: "x", tier_cap: 1, synthetic: true }
variants: ["happy"]
personas: ${f.personas}
`;
  };
  const writeSeed = (yml: string) => {
    const s = join(d, 'simulation/seeds/seed-1-test');
    mkdirSync(s, { recursive: true });
    for (const f of ['problem.json', 'stage-plan.json'])
      writeFileSync(join(s, f), '{}');
    writeFileSync(join(s, 'rubric.md'), 'r');
    writeFileSync(join(s, 'seed.yaml'), yml);
  };

  it('accepts a well formed seed', () => {
    writeSeed(seedYaml());
    expect(loadSeeds(d).map((s) => s.id)).toEqual(['seed-1-test']);
  });

  it('refuses a seed whose framing differs from FRAMINGS.json', () => {
    writeSeed(seedYaml({ framing: '"A different framing."' }));
    expect(() => loadSeeds(d)).toThrow(/framing/);
  });

  it('refuses a seed naming an unknown persona', () => {
    writeSeed(seedYaml({ personas: '["no-such-persona"]' }));
    expect(() => loadSeeds(d)).toThrow(/does not exist/);
  });

  it('refuses an attack row without an id, naming the line only', () => {
    const f = join(d, 'simulation/personas/adv-doxx/attacks.jsonl');
    writeFileSync(f, '{"payload":"PLANTED-CANARY-XYZ"}\n');
    const err = (() => {
      try {
        loadPersonas(d);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(SimDataError);
    expect(err!.message).not.toContain('PLANTED-CANARY-XYZ');
  });
});

describe('sim:sync', () => {
  const script = join(
    import.meta.dirname,
    '../../../scripts/sync-simulation-data.mjs',
  );
  it('exits 0 and skips when the sibling is absent (standalone checkout)', () => {
    // Run a copy of the script from a dir with no ../can_policy.
    const base = mkdtempSync(join(tmpdir(), 'simsync-'));
    mkdirSync(join(base, 'can_server/scripts'), { recursive: true });
    cpSync(script, join(base, 'can_server/scripts/sync-simulation-data.mjs'));
    const r = spawnSync(
      process.execPath,
      [join(base, 'can_server/scripts/sync-simulation-data.mjs')],
      { encoding: 'utf8' },
    );
    rmSync(base, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('skipped: can_policy not present');
  });
});
