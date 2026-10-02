import {
  computePackHash,
  sha256,
  versionString,
  type PackFiles,
} from '../domain/hash.js';
import {
  LAYERS,
  PackRefused,
  PolicyUnavailable,
  deepFreeze,
  type ChainLink,
  type CompiledPack,
  type Layer,
  type Ratification,
  type SchemaEntry,
} from '../domain/pack.js';
import {
  parseRules,
  resolveLayers,
  type ParsedRules,
} from '../domain/resolve.js';
import { parseYaml, type Yaml } from '../domain/yaml.js';
import type { PackSource } from './pack-source.js';

export interface PackRef {
  name: string;
  version: string; // semver
  hash: string; // 64 hex
}

const dec = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const HEX64 = /^[0-9a-f]{64}$/;

interface Loaded {
  pack: CompiledPack;
  parsed: ParsedRules;
}

export class PolicyStore {
  private readonly byHash = new Map<string, CompiledPack>();
  private readonly activeByJurisdiction = new Map<string, string>();
  private shadowHash: string | null = null;
  private canaryHash: string | null = null;
  private canaryPercent = 0;

  constructor(
    private readonly source: PackSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Load, verify and compile. Never touches the active pointers. Old versions stay loadable. */
  async load(
    name: string,
    version: string,
    expectedHash: string,
  ): Promise<CompiledPack> {
    if (!HEX64.test(expectedHash))
      throw new PackRefused('pinned hash must be 64 hex characters');
    const known = this.byHash.get(expectedHash);
    if (known && known.name === name && known.semver === version) return known;
    const { pack } = await this.loadChain(name, version, expectedHash, 0);
    this.byHash.set(pack.hash, pack);
    return pack;
  }

  private async loadChain(
    name: string,
    semver: string,
    expectedHash: string | null,
    depth: number,
  ): Promise<Loaded> {
    if (depth > LAYERS.length)
      throw new PackRefused('pack parent chain too deep');
    const files = await this.source.read(name, semver);
    const meta = this.yamlFile(files, 'pack.yaml') as Record<string, Yaml>;
    if (meta.name !== name || meta.semver !== semver)
      throw new PackRefused(`pack.yaml does not describe ${name}@${semver}`);
    const layer = meta.layer as Layer;
    if (!LAYERS.includes(layer))
      throw new PackRefused(`${name}: unknown layer ${String(meta.layer)}`);

    let parent: Loaded | null = null;
    if (meta.parent) {
      const m = /^([a-z0-9][a-z0-9-]*)@(.+)$/.exec(String(meta.parent));
      if (!m)
        throw new PackRefused(`${name}: bad parent ${String(meta.parent)}`);
      parent = await this.loadChain(m[1], m[2], null, depth + 1);
      if (LAYERS.indexOf(parent.pack.layer) >= LAYERS.indexOf(layer))
        throw new PackRefused(`${name}: parent must be a higher layer`);
    } else if (layer !== 'base')
      throw new PackRefused(`${name}: only a base pack may omit parent`);

    const hash = computePackHash(files, parent?.pack.hash ?? null);
    if (expectedHash !== null && hash !== expectedHash)
      throw new PackRefused(
        `${name}@${semver}: hash mismatch (pinned ${expectedHash.slice(0, 12)}, found ${hash.slice(0, 12)})`,
      );
    const manifest = JSON.parse(dec(this.need(files, 'manifest.json'))) as {
      pack_hash?: string;
    };
    if (manifest.pack_hash !== hash)
      throw new PackRefused(
        `${name}@${semver}: manifest.json does not match the files`,
      );

    const version = versionString(name, semver, hash);
    const ratification = this.checkRatification(files, version, hash);

    const schemas: Record<string, SchemaEntry> = {
      ...parent?.pack.schemas,
    };
    const types = new Set<string>();
    for (const p of files.keys()) {
      const m = /^content-schemas\/([^/]+)\/schema\.json$/.exec(p);
      if (m) types.add(m[1]);
    }
    for (const type of types) {
      const raw = this.need(files, `content-schemas/${type}/schema.json`);
      let schema: Record<string, unknown>;
      try {
        schema = JSON.parse(dec(raw)) as Record<string, unknown>;
      } catch {
        throw new PackRefused(
          `${name}: content-schemas/${type}/schema.json does not parse`,
        );
      }
      const msgFile = files.get(`content-schemas/${type}/messages.en.json`);
      schemas[type] = {
        type,
        schema,
        schemaId: String(schema.$id ?? type),
        schemaVersion: String(schema['x-version'] ?? semver),
        schemaHash: sha256(raw),
        messages: msgFile
          ? (JSON.parse(dec(msgFile)) as Record<string, unknown>)
          : {},
      };
    }

    const own = parseRules(
      files.has('rules.yaml') ? dec(files.get('rules.yaml')!) : '',
      name,
    );
    const merged = resolveLayers(
      parent
        ? [
            {
              name: parent.pack.name,
              parsed: {
                rules: parent.pack.rules,
                protectedCore: parent.pack.protectedCore,
              },
            },
            { name, parsed: own },
          ]
        : [{ name, parsed: own }],
    );
    const limits = {
      ...parent?.pack.limits,
      ...((files.has('limits.yaml')
        ? parseYaml(dec(files.get('limits.yaml')!))
        : {}) as Record<string, unknown>),
    };
    const chain: ChainLink[] = [
      ...(parent?.pack.chain ?? []),
      { name, semver, hash, layer },
    ];
    const pack = deepFreeze<CompiledPack>({
      name,
      semver,
      hash,
      version,
      layer,
      jurisdiction: meta.jurisdiction ? String(meta.jurisdiction) : null,
      chain,
      rules: merged.rules,
      protectedCore: merged.protectedCore,
      limits,
      schemas,
      ratification,
    });
    return { pack, parsed: merged };
  }

  private need(files: PackFiles, path: string): Uint8Array {
    const f = files.get(path);
    if (!f) throw new PackRefused(`missing ${path}`);
    return f;
  }

  private yamlFile(files: PackFiles, path: string): Yaml {
    try {
      return parseYaml(dec(this.need(files, path)));
    } catch (e) {
      throw e instanceof PackRefused
        ? e
        : new PackRefused(`${path}: ${(e as Error).message}`);
    }
  }

  /** FOUNDER-TRANS-1: a record naming this exact version and hash with approved_by and a future expires_at. */
  private checkRatification(
    files: PackFiles,
    version: string,
    hash: string,
  ): Ratification {
    for (const [path, bytes] of files) {
      if (!path.startsWith('ratifications/') || path.slice(14).includes('/'))
        continue;
      const m = /^---\n([\s\S]*?)\n---/.exec(dec(bytes).replace(/\r\n/g, '\n'));
      if (!m) continue;
      let r: Record<string, Yaml>;
      try {
        r = parseYaml(m[1]) as Record<string, Yaml>;
      } catch {
        continue;
      }
      if (r.version !== version || r.pack_hash !== hash) continue;
      const approvedBy =
        typeof r.approved_by === 'string' ? r.approved_by.trim() : '';
      const expiresAt = String(r.expires_at ?? '');
      const t = Date.parse(expiresAt);
      if (!approvedBy || Number.isNaN(t)) continue;
      if (t <= this.now().getTime())
        throw new PackRefused(`${version}: ratification expired ${expiresAt}`);
      return { approvedBy, expiresAt };
    }
    throw new PackRefused(`${version}: no valid ratification record`);
  }

  /** Load then point `jurisdiction` at it. A failed load leaves the previous pointer. */
  async activate(jurisdiction: string, ref: PackRef): Promise<CompiledPack> {
    const pack = await this.load(ref.name, ref.version, ref.hash);
    this.activeByJurisdiction.set(jurisdiction, pack.hash);
    return pack;
  }

  async setShadow(ref: PackRef | null): Promise<void> {
    this.shadowHash = ref
      ? (await this.load(ref.name, ref.version, ref.hash)).hash
      : null;
  }

  async setCanary(ref: PackRef | null, percent = 0): Promise<void> {
    this.canaryHash = ref
      ? (await this.load(ref.name, ref.version, ref.hash)).hash
      : null;
    this.canaryPercent = ref ? Math.min(100, Math.max(0, percent)) : 0;
  }

  /** Callers map PolicyUnavailable to `hold`, never to publish. */
  active(jurisdiction: string): CompiledPack {
    const h =
      this.activeByJurisdiction.get(jurisdiction) ??
      this.activeByJurisdiction.get('default');
    const p = h && this.byHash.get(h);
    if (!p)
      throw new PolicyUnavailable(`no active policy pack for ${jurisdiction}`);
    return p;
  }

  shadow(): CompiledPack | null {
    return this.shadowHash ? (this.byHash.get(this.shadowHash) ?? null) : null;
  }

  canary(): { pack: CompiledPack; percent: number } | null {
    const p = this.canaryHash ? this.byHash.get(this.canaryHash) : undefined;
    return p ? { pack: p, percent: this.canaryPercent } : null;
  }

  /** Any loaded pack by its version string, retired ones included (replays, appeals). */
  findByVersion(version: string): CompiledPack | undefined {
    return [...this.byHash.values()].find((p) => p.version === version);
  }
}
