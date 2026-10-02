import { createHash } from 'node:crypto';

/** Hash contract, must match can_policy 10-u03 exactly. */
export type PackFiles = ReadonlyMap<string, Uint8Array>;

const TEXT = /\.(json|ya?ml|md|txt)$/;
const EXCLUDED_ROOT = new Set([
  'manifest.json',
  'release.json',
  'CHANGELOG.md',
]);
const EXCLUDED_ROOT_DIRS = [
  'ratifications',
  'ci',
  'tools',
  'test',
  'node_modules',
];

export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

export function isHashed(path: string): boolean {
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.'))) return false;
  if (parts.length === 1 && EXCLUDED_ROOT.has(path)) return false;
  return !(parts.length > 1 && EXCLUDED_ROOT_DIRS.includes(parts[0]));
}

function fileHash(path: string, bytes: Uint8Array): string {
  if (!TEXT.test(path)) return sha256(bytes);
  return sha256(
    Buffer.from(
      Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n'),
      'utf8',
    ),
  );
}

export function manifestEntries(
  files: PackFiles,
): { path: string; sha256: string }[] {
  return [...files]
    .filter(([p]) => isHashed(p))
    .map(([path, bytes]) => ({ path, sha256: fileHash(path, bytes) }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

export function computePackHash(
  files: PackFiles,
  parentPackHash: string | null,
): string {
  const lines = [
    `parent:${parentPackHash ?? 'none'}`,
    ...manifestEntries(files).map((e) => `${e.path}\t${e.sha256}`),
  ];
  return sha256(lines.join('\n'));
}

export const versionString = (
  name: string,
  semver: string,
  hash: string,
): string => `${name}@${semver}+${hash.slice(0, 12)}`;
