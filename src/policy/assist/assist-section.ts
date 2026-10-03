import { computePackHash } from '../domain/hash.js';
import type { CompiledPack } from '../domain/pack.js';
import { parseYaml, type Yaml } from '../domain/yaml.js';
import type { PackSource } from '../app/pack-source.js';

export interface AssistSection {
  template: string;
  schema: Record<string, unknown>;
  ruleSlice: string;
  ruleIds: string[];
  /** Suggestions below this confidence are not offered. */
  publishFloor: number;
}

const dec = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const DIR = 'decision-points/ASSIST-FILL/';

/** Reads decision-points/ASSIST-FILL from the pack chain (nearest layer wins). Throws if absent or the files changed since load. */
export async function loadAssistSection(
  pack: CompiledPack,
  source: PackSource,
): Promise<AssistSection> {
  const files = new Map<string, Uint8Array>();
  let parent: string | null = null;
  for (const link of pack.chain) {
    const f = await source.read(link.name, link.semver);
    if (computePackHash(f, parent) !== link.hash)
      throw new Error('pack files changed since load');
    parent = link.hash;
    for (const [p, b] of f) if (p.startsWith(DIR)) files.set(p, b);
  }
  const get = (n: string) => {
    const b = files.get(DIR + n);
    if (!b) throw new Error(`ASSIST-FILL has no ${n}`);
    return dec(b);
  };
  const sec = parseYaml(get('pack-section.yaml')) as Record<string, Yaml>;
  const ruleIds = Array.isArray(sec.enforces) ? sec.enforces.map(String) : [];
  const floor = (
    (sec.thresholds as Record<string, Yaml> | undefined)?.confidence_floor as
      Record<string, Yaml> | undefined
  )?.publish;
  return {
    template: get('prompt.md'),
    schema: JSON.parse(get('schema.json')) as Record<string, unknown>,
    ruleIds,
    ruleSlice: pack.rules
      .filter((r) => ruleIds.includes(r.id))
      .map((r) => `${r.id}: ${r.text}`)
      .join('\n'),
    publishFloor: typeof floor === 'number' ? floor : 0.8,
  };
}
