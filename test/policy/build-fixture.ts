// Generates manifest.json and ratifications/ for test/fixtures/policy/*. Run: node test/policy/build-fixture.ts
// Deliberately re-implements the hash contract (can_policy 10-u03) so it cross-checks src/policy/domain/hash.ts.
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (d: string | Buffer) =>
  createHash('sha256').update(d).digest('hex');
const SKIP_ROOT = [
  'manifest.json',
  'release.json',
  'ratifications',
  'CHANGELOG.md',
  'ci',
  'tools',
  'test',
  'node_modules',
];

export function buildManifest(
  files: Map<string, Buffer>,
  parentHash: string | null,
  name: string,
  semver: string,
) {
  const entries = [...files.entries()]
    .filter(
      ([p]) =>
        !SKIP_ROOT.includes(p.split('/')[0]) &&
        !p.split('/').some((s) => s.startsWith('.')),
    )
    .map(([p, b]) => ({
      path: p,
      sha256: /\.(json|ya?ml|md|txt)$/.test(p)
        ? sha(b.toString('utf8').replaceAll('\r\n', '\n'))
        : sha(b),
    }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const packHash = sha(
    [
      'parent:' + (parentHash ?? 'none'),
      ...entries.map((e) => e.path + '\t' + e.sha256),
    ].join('\n'),
  );
  return {
    packHash,
    version: `${name}@${semver}+${packHash.slice(0, 12)}`,
    manifest:
      JSON.stringify(
        {
          pack_name: name,
          version: semver,
          pack_hash: packHash,
          parent_pack_hash: parentHash,
          files: entries,
        },
        null,
        2,
      ) + '\n',
  };
}

export function ratificationText(
  version: string,
  packHash: string,
  opts: { approvedBy?: string; expiresAt?: string } = {},
) {
  const by = opts.approvedBy ?? 'test-founder';
  return `---\nversion: ${version}\npack_hash: ${packHash}\napproved_by: ${by}\nexpires_at: ${opts.expiresAt ?? '2999-01-01'}\nnote: fixture ratification, not a real approval\n---\nFounder-transitional approval for a test pack.\n`;
}

function readTree(dir: string, rel = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const e of readdirSync(join(dir, rel))) {
    const p = rel ? `${rel}/${e}` : e;
    if (statSync(join(dir, p)).isDirectory())
      readTree(dir, p).forEach((v, k) => out.set(k, v));
    else out.set(p, readFileSync(join(dir, p)));
  }
  return out;
}

/** Order matters: each pack hashes its parent. Returns pack hashes by name. */
export const FIXTURE_PACKS: [string, string | null][] = [
  ['base', null],
  ['constitution', 'base'],
  ['fiktiva-city', 'constitution'],
];

export function writeFixture(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const [name, parent] of FIXTURE_PACKS) {
    const dir = join(root, `${name}@0.0.1`);
    const { packHash, version, manifest } = buildManifest(
      readTree(dir),
      parent ? hashes[parent] : null,
      name,
      '0.0.1',
    );
    hashes[name] = packHash;
    mkdirSync(join(dir, 'ratifications'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), manifest);
    writeFileSync(
      join(dir, 'ratifications', `${name}-0.0.1.md`),
      ratificationText(version, packHash),
    );
  }
  return hashes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'policy',
  );
  const h = writeFixture(root);
  console.log(
    JSON.stringify({
      default: {
        name: 'fiktiva-city',
        version: '0.0.1',
        hash: h['fiktiva-city'],
      },
    }),
  );
}
