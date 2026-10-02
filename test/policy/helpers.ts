import { join } from 'node:path';
import type { PackSource } from '../../src/policy/app/pack-source.js';
import { FsPackSource } from '../../src/policy/infra/fs-pack-source.js';
import { buildManifest, ratificationText } from './build-fixture.ts';

export const FIXTURE_DIR = join(process.cwd(), 'test/fixtures/policy');
export type Files = Map<string, Uint8Array>;

/** In-memory pack source seeded from the fixture; tests mutate it to make negative packs. */
export class MemorySource implements PackSource {
  packs = new Map<string, Files>();
  async read(name: string, semver: string): Promise<Files> {
    const f = this.packs.get(`${name}@${semver}`);
    if (!f) throw new Error('missing');
    return new Map(f);
  }
  static async fixture(): Promise<MemorySource> {
    const m = new MemorySource();
    const fs = new FsPackSource(FIXTURE_DIR);
    for (const n of ['base', 'constitution', 'fiktiva-city'])
      m.packs.set(`${n}@0.0.1`, new Map(await fs.read(n, '0.0.1')));
    return m;
  }
  text(name: string, path: string): string {
    return Buffer.from(this.packs.get(`${name}@0.0.1`)!.get(path)!).toString(
      'utf8',
    );
  }
  put(name: string, path: string, content: string): void {
    this.packs.get(`${name}@0.0.1`)!.set(path, Buffer.from(content));
  }
  /** Recompute manifest and (optionally) ratification for a chain base -> constitution -> fiktiva-city; returns hashes. */
  reseal(
    opts: { ratify?: boolean; approvedBy?: string; expiresAt?: string } = {},
  ): Record<string, string> {
    const hashes: Record<string, string> = {};
    let parent: string | null = null;
    for (const n of ['base', 'constitution', 'fiktiva-city']) {
      const files = this.packs.get(`${n}@0.0.1`)!;
      const b = buildManifest(files as Map<string, Buffer>, parent, n, '0.0.1');
      files.set('manifest.json', Buffer.from(b.manifest));
      for (const k of [...files.keys()])
        if (k.startsWith('ratifications/')) files.delete(k);
      if (opts.ratify !== false)
        files.set(
          `ratifications/${n}-0.0.1.md`,
          Buffer.from(ratificationText(b.version, b.packHash, opts)),
        );
      hashes[n] = parent = b.packHash;
    }
    return hashes;
  }
}
