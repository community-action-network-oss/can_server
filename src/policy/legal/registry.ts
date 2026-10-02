import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, desc, eq, inArray, lte, or, ne } from 'drizzle-orm';
import type { Db } from '../../db/db.module.js';
import { legalCorpusVersion as t } from '../../db/schema.js';
import { parseYaml, type Yaml } from '../domain/yaml.js';
import {
  LEGAL_LAYERS,
  LegalCorpusRefused,
  LegalLayerMissing,
  type CorpusState,
  type LegalPin,
  type LegalStackLayer,
  type LoadedCorpus,
} from './corpus.js';
import { loadCorpus } from './load.js';

/** Where the jurisdiction's pinned `legal_stack` comes from (the active jurisdiction pack). */
export type PinsSource = (jurisdiction: string) => Promise<Yaml | undefined>;

export const LEGAL_REGISTRY_DB = Symbol('LEGAL_REGISTRY_DB');

const key = (id: string, version: string, hash: string) =>
  `${id}@${version}#${hash}`;

/** Reads a corpus dir recursively into memory (pack-relative paths). */
export async function readCorpusDir(
  dir: string,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) files.set(p, await readFile(join(dir, p)));
    }
  };
  await walk('');
  return files;
}

/** Corpus dirs under a root: any directory holding corpus.yaml. */
export async function discoverCorpusDirs(
  root: string,
  rel = '',
): Promise<string[]> {
  const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(
    () => [],
  );
  if (entries.some((e) => e.isFile() && e.name === 'corpus.yaml'))
    return [join(root, rel)];
  const out: string[] = [];
  for (const e of entries)
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      out.push(
        ...(await discoverCorpusDirs(root, rel ? `${rel}/${e.name}` : e.name)),
      );
  return out.sort();
}

/** Validates the `legal_stack` list of a pack.yaml; anything off is a hold, never a partial stack. */
export function parseLegalStack(
  jurisdiction: string,
  raw: Yaml | undefined,
): LegalPin[] {
  const bad = (m: string) => new LegalLayerMissing(jurisdiction, null, m);
  if (!Array.isArray(raw) || raw.length !== LEGAL_LAYERS.length)
    throw bad('legal_stack must list exactly six layers');
  return raw.map((r, i) => {
    const p = r as Record<string, Yaml>;
    const layer = LEGAL_LAYERS[i];
    if (p?.layer !== layer) throw bad(`layer ${i + 1} must be ${layer}`);
    if (!['binding', 'reference', 'not_applicable'].includes(String(p.mode)))
      throw bad(`${layer}: unknown mode`);
    if (p.mode === 'not_applicable' && layer !== 'L2' && layer !== 'L5')
      throw bad(`${layer}: not_applicable is allowed only for L2 and L5`);
    if (typeof p.corpus === 'string') {
      if (
        p.mode === 'not_applicable' ||
        !p.version ||
        !/^[0-9a-f]{64}$/.test(String(p.pack_hash))
      )
        throw bad(
          `${layer}: a pinned corpus needs version and a 64 hex pack_hash`,
        );
    } else if (!p.reason) throw bad(`${layer}: corpus null needs a reason`);
    return p as unknown as LegalPin;
  });
}

export class LegalRegistry {
  private readonly loaded = new Map<string, LoadedCorpus>();

  constructor(
    private readonly db: Db,
    private readonly pins: PinsSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Verify and keep in memory. A refused corpus changes nothing: whatever served before keeps serving. */
  async register(dir: string, expectedHash?: string): Promise<LoadedCorpus> {
    let files: Map<string, Uint8Array>;
    try {
      files = await readCorpusDir(dir);
    } catch (e) {
      throw new LegalCorpusRefused(
        `cannot read corpus: ${(e as Error).message}`,
      );
    }
    const c = loadCorpus(files, expectedHash);
    this.loaded.set(key(c.id, c.version, c.hash), c);
    return c;
  }

  /** Minimal activation (09-u27 PolicyActivation will wrap it): this version active, the previous one retired. */
  async activate(c: LoadedCorpus, at: Date = this.now()): Promise<void> {
    if (this.loaded.get(key(c.id, c.version, c.hash)) !== c)
      throw new LegalCorpusRefused(
        `${c.corpusVersion} was not loaded through the registry`,
      );
    await this.db.transaction(async (tx) => {
      await tx
        .update(t)
        .set({ state: 'retired' })
        .where(
          and(
            eq(t.jurisdiction, c.jurisdiction),
            eq(t.corpusId, c.id),
            eq(t.state, 'active'),
            or(ne(t.version, c.version), ne(t.hash, c.hash)),
          ),
        );
      const row = {
        layer: c.layer,
        jurisdiction: c.jurisdiction,
        corpusId: c.id,
        version: c.version,
        hash: c.hash,
      };
      await tx
        .insert(t)
        .values({ ...row, state: 'active', activatedAt: at })
        .onConflictDoUpdate({
          target: [t.corpusId, t.version, t.hash],
          set: { state: 'active', activatedAt: at },
        });
    });
  }

  async list() {
    return this.db
      .select()
      .from(t)
      .orderBy(
        asc(t.layer),
        asc(t.jurisdiction),
        asc(t.corpusId),
        asc(t.activatedAt),
      );
  }

  /**
   * The six layers for a jurisdiction at `at`, as its legal_stack pins declare. Anything not provably
   * the pinned, verified, activated corpus throws LegalLayerMissing (callers return `hold`).
   */
  async stackFor(
    jurisdiction: string,
    at: Date = this.now(),
  ): Promise<LegalStackLayer[]> {
    const raw = await this.pins(jurisdiction);
    if (!raw)
      throw new LegalLayerMissing(jurisdiction, null, 'no legal_stack pinned');
    const pins = parseLegalStack(jurisdiction, raw);
    const out: LegalStackLayer[] = [];
    for (const pin of pins) {
      const miss = (m: string) =>
        new LegalLayerMissing(jurisdiction, pin.layer, m);
      if (pin.corpus === null) {
        if (
          pin.mode === 'not_applicable' &&
          (pin.layer === 'L2' || pin.layer === 'L5') &&
          pin.reason
        )
          out.push({
            layer: pin.layer,
            corpus: null,
            mode: 'not_applicable',
            indexOnly: false,
          });
        else throw miss(`no corpus pinned (${pin.reason ?? 'no reason'})`);
        continue;
      }
      if (pin.mode === 'not_applicable')
        throw miss('not_applicable with a corpus');
      const [row] = await this.db
        .select()
        .from(t)
        .where(
          and(
            eq(t.corpusId, pin.corpus),
            lte(t.activatedAt, at),
            inArray(t.state, ['active', 'retired'] satisfies CorpusState[]),
          ),
        )
        .orderBy(desc(t.activatedAt))
        .limit(1);
      if (!row) throw miss(`${pin.corpus} is not active`);
      // The current activation must be exactly the pin; an older date may be served by a retired version.
      if (
        row.state === 'active' &&
        (row.version !== pin.version || row.hash !== pin.pack_hash)
      )
        throw miss(`${pin.corpus} active version differs from the pin`);
      const c = this.loaded.get(key(row.corpusId, row.version, row.hash));
      if (!c) throw miss(`${pin.corpus}@${row.version} is not loaded`);
      if (c.layer !== pin.layer || c.jurisdiction !== row.jurisdiction)
        throw miss(`${pin.corpus} is not an ${pin.layer} corpus`);
      if (
        c.effectiveFrom > at.toISOString().slice(0, 10) ||
        (c.effectiveTo && c.effectiveTo < at.toISOString().slice(0, 10))
      )
        throw miss(`${pin.corpus}@${c.version} is not in force on that date`);
      if (pin.mode === 'binding' && c.mode === 'reference')
        throw miss(
          `${pin.corpus} is reference only and cannot be pinned binding`,
        );
      const indexOnly = c.status === 'index_only';
      if (
        pin.mode === 'binding' &&
        indexOnly &&
        pin.acknowledged_index_only !== true
      )
        throw miss(
          `${pin.corpus} is an index_only stub pinned binding without acknowledged_index_only`,
        );
      if (pin.mode === 'binding' && !indexOnly && !c.reviewed)
        throw miss(`${pin.corpus} is unreviewed and cannot bind`);
      out.push({ layer: pin.layer, corpus: c, mode: pin.mode, indexOnly });
    }
    return out;
  }
}
