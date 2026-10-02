import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computePackHash, sha256 } from '../../src/policy/domain/hash.js';
import { parseYaml, type Yaml } from '../../src/policy/domain/yaml.js';
import { readCorpusDir } from '../../src/policy/legal/registry.js';

/** Invented corpora of the fictional world Fiktiva (never ../can_policy). */
export const LEGAL_FX = join(process.cwd(), 'test/fixtures/legal');
export const dirOf = (layerDir: string, name: string) =>
  join(LEGAL_FX, layerDir, 'fiktiva', name);
export const FIKTIVA_DIRS = [
  ['L1-un', 'rights'],
  ['L2-supranational', 'union'],
  ['L3-constitution', 'constitution'],
  ['L4-national', 'statutes'],
  ['L5-regional', 'region'],
  ['L6-city', 'bylaws'],
] as const;
export const fiktivaStack = (): Yaml =>
  (
    parseYaml(
      readFileSync(join(LEGAL_FX, 'stacks/fiktiva-city.yaml'), 'utf8'),
    ) as Record<string, Yaml>
  ).legal_stack;

export const tmpCopy = (src: string): string => {
  const d = join(mkdtempSync(join(tmpdir(), 'legal-')), 'c');
  cpSync(src, d, { recursive: true });
  return d;
};
export const edit = (file: string, fn: (s: string) => string) =>
  writeFileSync(file, fn(readFileSync(file, 'utf8')));

/** Re-seal a copied corpus after a legitimate edit: article hashes, content_hash, version, manifest. */
export async function reseal(dir: string, version: string): Promise<string> {
  const bodies: string[] = [];
  for (const f of readdirSync(join(dir, 'articles')).sort()) {
    const p = join(dir, 'articles', f);
    const m = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/.exec(
      readFileSync(p, 'utf8'),
    )!;
    edit(p, (s) =>
      s.replace(/text_sha256: \w+/, `text_sha256: ${sha256(m[2])}`),
    );
    bodies.push(m[2]);
  }
  for (const f of ['corpus.yaml', 'pack.yaml'])
    edit(join(dir, f), (s) =>
      s.replace(/^version: .*$/m, `version: ${version}`),
    );
  edit(join(dir, 'corpus.yaml'), (s) =>
    s.replace(
      /^content_hash: .*$/m,
      `content_hash: ${sha256(bodies.join(''))}`,
    ),
  );
  const hash = computePackHash(await readCorpusDir(dir), null);
  edit(join(dir, 'manifest.json'), (s) =>
    s.replace(/"pack_hash": "\w+"/, `"pack_hash": "${hash}"`),
  );
  return hash;
}
