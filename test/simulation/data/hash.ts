import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const walk = (dir: string, base = dir): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name), base)
      : e.name === 'SOURCE.json' || e.name === '.gitkeep'
        ? []
        : [join(dir, e.name).slice(base.length + 1)],
  );

/** Same algorithm as scripts/sync-simulation-data.mjs: sha256 over sorted "path NUL bytes NUL". */
export function hashTree(dir: string): { sha256: string; files: number } {
  const h = createHash('sha256');
  const files = walk(dir).sort();
  for (const f of files)
    h.update(f)
      .update('\0')
      .update(readFileSync(join(dir, f)))
      .update('\0');
  return { sha256: h.digest('hex'), files: files.length };
}
