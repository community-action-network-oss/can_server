import type { PackSource } from '../app/pack-source.js';
import type { ChainLink } from '../domain/pack.js';
import { parseMap, type MigrationMap } from './migrate.js';

/**
 * Finds `content-schemas/<type>/migrations/<from>-to-<to>.json` in the active pack chain, most specific pack first.
 * ponytail: files are re-read from disk (the pack itself was hash-verified at load); results, misses included, are cached per chain.
 */
export class MigrationMaps {
  private readonly cache = new Map<string, Promise<MigrationMap | null>>();
  constructor(private readonly source: PackSource) {}

  find(
    chain: readonly ChainLink[],
    type: string,
    from: string,
    to: string,
  ): Promise<MigrationMap | null> {
    const key = `${chain.at(-1)?.hash}:${type}:${from}:${to}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = this.load(chain, type, from, to);
      this.cache.set(key, hit);
    }
    return hit;
  }

  private async load(
    chain: readonly ChainLink[],
    type: string,
    from: string,
    to: string,
  ): Promise<MigrationMap | null> {
    const path = `content-schemas/${type}/migrations/${from}-to-${to}.json`;
    for (const link of [...chain].reverse()) {
      const files = await this.source
        .read(link.name, link.semver)
        .catch(() => null);
      const raw = files?.get(path);
      if (raw)
        return parseMap(Buffer.from(raw).toString('utf8'), type, from, to);
    }
    return null;
  }
}
