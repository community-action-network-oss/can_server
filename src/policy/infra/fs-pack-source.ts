import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackSource } from '../app/pack-source.js';
import { PackRefused } from '../domain/pack.js';

/** Reads `<root>/<name>@<semver>/` recursively into memory. */
export class FsPackSource implements PackSource {
  constructor(private readonly root: string) {}

  async read(name: string, semver: string): Promise<Map<string, Uint8Array>> {
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(name) ||
      !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(semver)
    )
      throw new PackRefused(`bad pack name or version ${name}@${semver}`);
    const dir = join(this.root, `${name}@${semver}`);
    const files = new Map<string, Uint8Array>();
    const walk = async (rel: string): Promise<void> => {
      for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') await walk(p);
        } else if (e.isFile()) files.set(p, await readFile(join(dir, p)));
      }
    };
    try {
      await walk('');
    } catch (err) {
      throw new PackRefused(
        `cannot read pack ${name}@${semver}: ${(err as Error).message}`,
      );
    }
    return files;
  }
}
