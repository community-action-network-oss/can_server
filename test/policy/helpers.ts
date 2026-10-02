import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackSource } from '../../src/policy/app/pack-source.js';
import { FsPackSource } from '../../src/policy/infra/fs-pack-source.js';
import { buildManifest, ratificationText } from './build-fixture.ts';

export const FIXTURE_DIR = join(process.cwd(), 'test/fixtures/policy');
/** Committed can_policy v1.0.0 export (D-82); refresh with scripts/sync-policy-fixture.mjs. */
export const FIXTURE_V1_DIR = join(process.cwd(), 'test/fixtures/policy-v1');
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

/**
 * Copy of the v1 export with a test ratification per pack. The released candidate carries none
 * (FOUNDER-TRANS-1 refuses it); ratifications are outside the pack hash, so the pinned hashes hold.
 */
export function ratifiedV1(): { dir: string; hash: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'policy-v1-'));
  cpSync(FIXTURE_V1_DIR, dir, { recursive: true });
  const pins: Record<string, string> = JSON.parse(
    readFileSync(join(FIXTURE_V1_DIR, 'PINS.json'), 'utf8'),
  );
  const hash: Record<string, string> = {};
  for (const [key, h] of Object.entries(pins)) {
    const [name, semver] = key.split('@');
    mkdirSync(join(dir, key, 'ratifications'), { recursive: true });
    writeFileSync(
      join(dir, key, 'ratifications', `${name}-${semver}.md`),
      ratificationText(`${key}+${h.slice(0, 12)}`, h),
    );
    hash[name] = h;
  }
  return { dir, hash };
}
