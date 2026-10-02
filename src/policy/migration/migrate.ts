// Pure draft migration rules (10-u31). Map format mirrors can_policy schemas/migration-map.schema.json.
export type Bump = 'none' | 'patch' | 'minor' | 'major' | 'rollback';
export type Transform = 'copy' | 'split' | 'merge' | 'drop';
export interface MapField {
  from_path: string;
  to_path: string;
  transform: Transform;
  note?: string;
}
export interface MigrationMap {
  type: string;
  from: string;
  to: string;
  fields: MapField[];
  new_required: string[];
  dropped: string[];
}
export interface MappingRow {
  from_path: string;
  to_path: string;
  transform: Transform;
  carried_value: unknown;
  needs_confirmation: boolean;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const parse = (v: string): number[] => {
  if (!SEMVER.test(v)) throw new Error(`not a semver: ${v}`);
  return v.split('.').map(Number);
};

/** patch: wording; minor: optional fields or bounds; major: required fields. A lower target is a rollback. */
export function classifyBump(from: string, to: string): Bump {
  const [a, b] = [parse(from), parse(to)];
  for (let i = 0; i < 3; i++) {
    if (b[i] === a[i]) continue;
    if (b[i] < a[i]) return 'rollback';
    return i === 0 ? 'major' : i === 1 ? 'minor' : 'patch';
  }
  return 'none';
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
/** "a/b", "/a/b" and "a.b" all mean the same path. */
const segs = (p: string) => {
  const s = p.replace(/^\//, '').split(/[/.]/).filter(Boolean);
  if (!s.length || s.some((k) => FORBIDDEN.has(k)))
    throw new Error(`bad path: ${p}`);
  return s;
};
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function getPath(o: unknown, path: string): unknown {
  let cur = o;
  for (const k of segs(path)) {
    if (!isObj(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}
function setPath(o: Obj, path: string, v: unknown): void {
  const s = segs(path);
  let cur = o;
  for (const k of s.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Obj;
  }
  cur[s[s.length - 1]] = v;
}
export const mappingKey = (f: { from_path: string; to_path: string }) =>
  `${f.from_path}\u0000${f.to_path}`;
const empty = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === '' ||
  (isObj(v) && !Object.keys(v).length);

/**
 * Moves an answer body across a major bump. copy applies on its own; split, merge and drop
 * need the poster's confirmation (`confirmed` null means "assume everything confirmed", for previews).
 * Untouched top-level answers carry over unless the target schema no longer has them (`allowed`).
 * `new_required` lists required target fields still empty afterwards: they are asked fresh.
 */
export function applyMap(
  body: Obj,
  map: MigrationMap,
  confirmed: ReadonlySet<string> | null,
  allowed?: readonly string[],
): {
  content: Obj;
  mapping: MappingRow[];
  new_required: string[];
  dropped: string[];
} {
  const content: Obj = {};
  const dropped = [...map.dropped];
  const consumed = new Set(map.fields.map((f) => segs(f.from_path)[0]));
  for (const [k, v] of Object.entries(body)) {
    if (consumed.has(k) || FORBIDDEN.has(k)) continue;
    if (allowed && !allowed.includes(k)) {
      if (!dropped.includes(k)) dropped.push(k);
      continue;
    }
    content[k] = v;
  }
  const mapping: MappingRow[] = [];
  for (const f of map.fields) {
    const v = getPath(body, f.from_path);
    const needs = f.transform !== 'copy';
    mapping.push({
      from_path: f.from_path,
      to_path: f.to_path,
      transform: f.transform,
      carried_value: v ?? null,
      needs_confirmation: needs,
    });
    if (f.transform === 'drop' || empty(v)) continue;
    if (needs && confirmed && !confirmed.has(mappingKey(f))) continue;
    const cur = getPath(content, f.to_path);
    setPath(
      content,
      f.to_path,
      f.transform === 'merge' &&
        typeof cur === 'string' &&
        typeof v === 'string'
        ? `${cur}\n${v}`
        : v,
    );
  }
  return {
    content,
    mapping,
    new_required: map.new_required.filter((p) => empty(getPath(content, p))),
    dropped,
  };
}

/** Parses a migration map file; null when it is not a usable map for exactly this step. */
export function parseMap(
  text: string,
  type: string,
  from: string,
  to: string,
): MigrationMap | null {
  try {
    const m = JSON.parse(text) as Partial<MigrationMap> & {
      transforms?: MapField[];
    };
    const fields = m.fields ?? m.transforms;
    if (
      m.type !== type ||
      m.from !== from ||
      m.to !== to ||
      !Array.isArray(fields) ||
      !Array.isArray(m.new_required) ||
      !Array.isArray(m.dropped)
    )
      return null;
    for (const f of fields) {
      segs(f.from_path);
      if (f.transform !== 'drop') segs(f.to_path);
    }
    return {
      type,
      from,
      to,
      fields,
      new_required: m.new_required,
      dropped: m.dropped,
    };
  } catch {
    return null;
  }
}
