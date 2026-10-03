// Loaders for the synced can_policy simulation data (11-u12). Test-side only; imports nothing from src/.
// Fail closed: any invalid file throws SimDataError. Errors carry paths, ids and schema messages, never data
// values: attack data holds planted fictional personal data by design.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { load as parseYaml } from 'js-yaml';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, normalize } from 'node:path';

export const DATA_DIR = join(import.meta.dirname, '../fixtures/data');

export class SimDataError extends Error {}

export interface Persona {
  id: string;
  family: string;
  synthetic: true;
  script: string;
  prompt?: string;
  attack_data?: string;
  expected: { step_id: string; outcomes?: string[] }[];
  [k: string]: unknown;
}
export interface ScriptStep {
  id: string;
  action: string;
  when?: { after_step?: string };
  [k: string]: unknown;
}
export interface Script {
  steps: ScriptStep[];
  [k: string]: unknown;
}
export interface AttackRow {
  id: string;
  [k: string]: unknown;
}
export interface LoadedPersona {
  persona: Persona;
  /** Every script*.json in the persona directory, by file name. */
  scripts: Record<string, Script>;
  prompt?: string;
  attacks: AttackRow[];
}
export interface Seed {
  id: string;
  number: number;
  framing: string;
  personas: string[];
  problem: string;
  rubric: string;
  stage_plan: string;
  [k: string]: unknown;
}
export interface Thresholds {
  fake_recordings_satisfy: false;
  forbid_model_id_prefix: 'fake-derived-';
  [k: string]: unknown;
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictTypes: true,
  strictRequired: true,
});
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function validator(dir: string, name: string) {
  const key = `${dir}|${name}`;
  let v = validators.get(key);
  if (!v) {
    const schema = JSON.parse(
      readFileSync(join(dir, 'schemas', `${name}.schema.json`), 'utf8'),
    );
    delete schema.$id; // the same $id would clash across data dirs; local resolution is all we need
    v = ajv.compile(schema);
    validators.set(key, v);
  }
  return v;
}

function check(dir: string, name: string, doc: unknown, rel: string): void {
  const v = validator(dir, name);
  if (!v(doc)) {
    const why = (v.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new SimDataError(`${rel}: fails ${name} schema: ${why}`);
  }
}

function read(dir: string, rel: string): string {
  const abs = join(dir, rel);
  if (!existsSync(abs)) throw new SimDataError(`${rel}: missing`);
  return readFileSync(abs, 'utf8');
}

function yaml(dir: string, rel: string): unknown {
  try {
    return parseYaml(read(dir, rel));
  } catch (e) {
    if (e instanceof SimDataError) throw e;
    throw new SimDataError(`${rel}: not valid YAML`);
  }
}

function json(dir: string, rel: string): unknown {
  try {
    return JSON.parse(read(dir, rel));
  } catch (e) {
    if (e instanceof SimDataError) throw e;
    throw new SimDataError(`${rel}: not valid JSON`);
  }
}

const subdirs = (p: string): string[] =>
  existsSync(p)
    ? readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort()
    : [];

/** A path named inside a data file must stay inside its own directory. */
function inside(base: string, rel: string, from: string): string {
  const n = normalize(join(base, rel));
  if (!n.startsWith(normalize(base) + '/'))
    throw new SimDataError(`${from}: '${rel}' must stay inside its directory`);
  return n;
}

export function loadFramings(dir = DATA_DIR): Record<string, string> {
  return json(dir, 'simulation/FRAMINGS.json') as Record<string, string>;
}

export function loadThresholds(dir = DATA_DIR): Thresholds {
  const rel = 'simulation/thresholds.yaml';
  const t = yaml(dir, rel);
  check(dir, 'thresholds', t, rel);
  const th = t as Thresholds;
  // Defence in depth: the schema consts, repeated. Fake recordings never count.
  if (th.fake_recordings_satisfy !== false)
    throw new SimDataError(`${rel}: fake_recordings_satisfy must be false`);
  if (th.forbid_model_id_prefix !== 'fake-derived-')
    throw new SimDataError(
      `${rel}: forbid_model_id_prefix must be fake-derived-`,
    );
  return th;
}

export function loadPersonas(dir = DATA_DIR): LoadedPersona[] {
  const root = join(dir, 'simulation/personas');
  return subdirs(root).map((id) => {
    const pdir = `simulation/personas/${id}`;
    const rel = `${pdir}/persona.yaml`;
    const persona = yaml(dir, rel) as Persona;
    check(dir, 'persona', persona, rel);
    if (persona.id !== id)
      throw new SimDataError(
        `${rel}: id must equal its directory name '${id}'`,
      );
    if (persona.synthetic !== true)
      throw new SimDataError(`${rel}: persona is not synthetic: true`);

    const base = join(dir, pdir);
    for (const k of ['script', 'prompt', 'attack_data'] as const) {
      const v = persona[k];
      if (v !== undefined && !existsSync(inside(base, v, rel)))
        throw new SimDataError(`${rel}: ${k} '${v}' does not exist`);
    }

    const scripts: Record<string, Script> = {};
    const variants = readdirSync(base).filter((f) =>
      /^script.*\.json$/.test(f),
    );
    for (const f of [...new Set([persona.script, ...variants])].sort()) {
      const srel = `${pdir}/${f}`;
      const s = json(dir, srel) as Script;
      check(dir, 'script', s, srel);
      const ids = s.steps.map((x) => x.id);
      ids.forEach((x, i) => {
        if (ids.indexOf(x) !== i)
          throw new SimDataError(`${srel}: duplicate step id '${x}'`);
      });
      for (const st of s.steps)
        if (st.when?.after_step && !ids.includes(st.when.after_step))
          throw new SimDataError(
            `${srel}: step ${st.id} runs after unknown step '${st.when.after_step}'`,
          );
      scripts[f] = s;
    }
    for (const e of persona.expected)
      if (!scripts[persona.script].steps.some((s) => s.id === e.step_id))
        throw new SimDataError(
          `${rel}: expected step_id '${e.step_id}' is not a step of ${persona.script}`,
        );

    const attacks: AttackRow[] = [];
    if (persona.attack_data) {
      const arel = `${pdir}/${persona.attack_data}`;
      read(dir, arel)
        .split('\n')
        .forEach((line, i) => {
          if (!line.trim()) return;
          let row: AttackRow;
          try {
            row = JSON.parse(line);
          } catch {
            throw new SimDataError(`${arel}: line ${i + 1} is not valid JSON`);
          }
          if (typeof row?.id !== 'string' || !row.id)
            throw new SimDataError(`${arel}: line ${i + 1} has no id`);
          if (attacks.some((a) => a.id === row.id))
            throw new SimDataError(`${arel}: duplicate attack id '${row.id}'`);
          attacks.push(row);
        });
    }
    return {
      persona,
      scripts,
      prompt: persona.prompt
        ? read(dir, `${pdir}/${persona.prompt}`)
        : undefined,
      attacks,
    };
  });
}

export function loadSeeds(dir = DATA_DIR): Seed[] {
  const framings = loadFramings(dir);
  const personaIds = new Set(subdirs(join(dir, 'simulation/personas')));
  return subdirs(join(dir, 'simulation/seeds')).map((id) => {
    const sdir = `simulation/seeds/${id}`;
    const rel = `${sdir}/seed.yaml`;
    const seed = yaml(dir, rel) as Seed;
    check(dir, 'seed', seed, rel);
    if (seed.id !== id)
      throw new SimDataError(
        `${rel}: id must equal its directory name '${id}'`,
      );
    if (framings[String(seed.number)] !== seed.framing)
      throw new SimDataError(
        `${rel}: framing is not byte for byte framing ${seed.number} in FRAMINGS.json`,
      );
    for (const pid of seed.personas)
      if (!personaIds.has(pid))
        throw new SimDataError(`${rel}: persona '${pid}' does not exist`);
    for (const k of ['problem', 'rubric', 'stage_plan'] as const)
      if (!existsSync(inside(join(dir, sdir), seed[k], rel)))
        throw new SimDataError(`${rel}: ${k} '${seed[k]}' does not exist`);
    return seed;
  });
}
