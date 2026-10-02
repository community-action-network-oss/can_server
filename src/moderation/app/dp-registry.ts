import {
  computePackHash,
  sha256,
  type PackFiles,
} from '../../policy/domain/hash.js';
import { PackRefused, type CompiledPack } from '../../policy/domain/pack.js';
import { parseYaml, type Yaml } from '../../policy/domain/yaml.js';
import type { PackSource } from '../../policy/app/pack-source.js';
import type { PolicyStore } from '../../policy/app/policy-store.js';
import {
  DP_IDS,
  ESCALATING_DPS,
  OUTCOMES,
  type DpId,
  type Outcome,
} from '../domain/outcome.js';
import type { ContentType, DpMode } from '../domain/selector/events.js';
import { SELECTOR_TABLE } from '../domain/selector/table.js';

/** DPs whose pack section must never list `reject` (decision-points.md). */
const NEVER_REJECT: readonly string[] = [
  'DP-LEGAL',
  'DP-APPEAL',
  'DP-SOURCE-TRUST',
  'DP-RERESOLUTION',
];

/** DP-RERESOLUTION speaks keep/annotate/reopen/hold in its required `resolution` field; the shared outcome follows this map. */
export const RERESOLUTION_MAP = {
  keep: 'publish',
  annotate: 'needs_revision',
  reopen: 'route_external',
  hold: 'hold',
} as const satisfies Record<string, Outcome>;

export interface DpEntry {
  id: string;
  mode: DpMode;
  /** Outcomes the pack allows this DP to emit (already checked against the shared contract). */
  outcomes: readonly Outcome[];
  /** Prompt input names from the section. */
  inputs: readonly string[];
  /** Rule ids the section enforces. */
  ruleIds: readonly string[];
  thresholds: Record<string, Yaml>;
  /** Parsed schema.json (the output contract). */
  schema: Record<string, unknown>;
  /** sha256 of the prompt.md file; the rendered-template hash of 09-u08 supersedes it per run. */
  promptHash: string;
  /** The prompt takes legal_L1..legal_L6 lines, so the run must get them from tryRetrieveLegal or hold. */
  usesLegalLines: boolean;
  /** Content types the selector can run it on (selector table, not the pack). */
  contentTypes: readonly ContentType[];
  /** Pack that last supplied the section. */
  source: string;
}

export interface DpView {
  policyVersion: string;
  packHash: string;
  dps: ReadonlyMap<string, DpEntry>;
  /** Catalog DPs with no usable section in the pack: callers hold, never skip. */
  missing: readonly DpId[];
  /** Sections present but refused (bad mode, outcome set, schema), with the reason. Also counted as missing. */
  invalid: readonly { id: string; reason: string }[];
  /** Pack DP sections the catalog does not know (needs a domain list and CHECK migration before use). */
  uncataloged: readonly string[];
}

const dec = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const SECTION =
  /^decision-points\/([^/]+)\/(pack-section\.yaml|prompt\.md|schema\.json)$/;
const strs = (v: Yaml | undefined): string[] =>
  Array.isArray(v) ? v.map(String) : [];

/** Reads the DP sections of the active pack. The pack is the only source: no list of DPs lives in code but the catalog check. */
export class DpRegistry {
  private readonly cache = new Map<string, DpView>();

  constructor(
    private readonly store: PolicyStore,
    private readonly source: PackSource,
  ) {}

  /** Throws PolicyUnavailable when no pack is active; callers map that to hold. */
  forJurisdiction(jurisdiction: string): Promise<DpView> {
    return this.forPack(this.store.active(jurisdiction));
  }

  async forPack(pack: CompiledPack): Promise<DpView> {
    const hit = this.cache.get(pack.hash);
    if (hit) return hit;
    const files = new Map<string, { bytes: Uint8Array; from: string }>();
    let parent: string | null = null;
    for (const link of pack.chain) {
      const f: PackFiles = await this.source.read(link.name, link.semver);
      // The store verified the hash at load; a source that changed since is refused, not trusted.
      if (computePackHash(f, parent) !== link.hash)
        throw new PackRefused(
          `${link.name}@${link.semver}: files changed since load`,
        );
      parent = link.hash;
      for (const [p, bytes] of f)
        if (SECTION.test(p)) files.set(p, { bytes, from: link.name });
    }
    const view = this.build(pack, files);
    this.cache.set(pack.hash, view);
    return view;
  }

  private build(
    pack: CompiledPack,
    files: Map<string, { bytes: Uint8Array; from: string }>,
  ): DpView {
    const ids = new Set<string>();
    for (const p of files.keys()) ids.add(SECTION.exec(p)![1]);
    const dps = new Map<string, DpEntry>();
    const invalid: { id: string; reason: string }[] = [];
    const uncataloged: string[] = [];
    for (const id of [...ids].sort()) {
      if (!id.startsWith('DP-')) continue; // ASSIST-FILL and _template are not decision points
      if (!(DP_IDS as readonly string[]).includes(id)) uncataloged.push(id);
      try {
        dps.set(id, this.entry(id, files));
      } catch (e) {
        invalid.push({ id, reason: (e as Error).message });
      }
    }
    const usable = (id: string) =>
      dps.has(id) && (DP_IDS as readonly string[]).includes(id);
    return {
      policyVersion: pack.version,
      packHash: pack.hash,
      dps,
      missing: DP_IDS.filter((id) => !usable(id)),
      invalid,
      uncataloged,
    };
  }

  private entry(
    id: string,
    files: Map<string, { bytes: Uint8Array; from: string }>,
  ): DpEntry {
    const get = (n: string) => files.get(`decision-points/${id}/${n}`);
    const sec = get('pack-section.yaml');
    const prompt = get('prompt.md');
    const schemaFile = get('schema.json');
    if (!sec || !prompt || !schemaFile)
      throw new Error('needs pack-section.yaml, prompt.md and schema.json');
    const y = parseYaml(dec(sec.bytes)) as Record<string, Yaml>;
    if (y.dp !== id) throw new Error('section dp does not match its directory');
    if (y.mode !== 'blocking' && y.mode !== 'async')
      throw new Error('mode must be blocking or async');
    const outcomes = strs(y.outcomes);
    if (
      !outcomes.length ||
      !outcomes.every((o) => (OUTCOMES as readonly string[]).includes(o))
    )
      throw new Error('outcomes must be a non-empty subset of the six');
    if (
      outcomes.includes('escalate_human') &&
      !(ESCALATING_DPS as readonly string[]).includes(id)
    )
      throw new Error('escalate_human is not allowed for this DP');
    if (outcomes.includes('reject') && NEVER_REJECT.includes(id))
      throw new Error('this DP never rejects');
    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(dec(schemaFile.bytes)) as Record<string, unknown>;
    } catch {
      throw new Error('schema.json does not parse');
    }
    if (
      id === 'DP-RERESOLUTION' &&
      !(schema.required as string[] | undefined)?.includes('resolution')
    )
      throw new Error('schema must require `resolution`');
    const rule = (
      SELECTOR_TABLE as Record<string, { types: readonly ContentType[] }>
    )[id];
    return {
      id,
      mode: y.mode,
      outcomes: outcomes as Outcome[],
      inputs: strs(y.inputs),
      ruleIds: strs(y.enforces),
      thresholds: (y.thresholds ?? {}) as Record<string, Yaml>,
      schema,
      promptHash: sha256(prompt.bytes),
      usesLegalLines: dec(prompt.bytes).includes('legal_L1'),
      contentTypes: rule?.types ?? [],
      source: sec.from,
    };
  }
}
