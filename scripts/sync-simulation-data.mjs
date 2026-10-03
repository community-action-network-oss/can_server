// Copies simulation data and its schemas from the sibling can_policy into test/simulation/fixtures/data (11-u12).
// Stdlib only. No sibling repo: exit 0 and keep the committed copy. Tests and loaders never read ../can_policy.
// `--check` reports drift between the sibling and the committed copy (exit 1) and writes nothing.
// Attack data holds planted fictional personal data by design: this script prints counts, never contents.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const policy = join(root, '../can_policy');
const out = join(root, 'test/simulation/fixtures/data');
const SCHEMAS = ['persona', 'script', 'seed', 'thresholds'];

if (!existsSync(join(policy, 'simulation'))) {
  console.log('skipped: can_policy not present');
  process.exit(0);
}

const walk = (dir, base = dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), base) : e.name === '.gitkeep' || e.name === 'SOURCE.json' ? [] : [join(dir, e.name).slice(base.length + 1)],
  );
// Same algorithm as test/simulation/data/hash.ts: sha256 over sorted "path NUL bytes NUL".
const hashTree = (dir) => {
  const h = createHash('sha256');
  for (const f of walk(dir).sort()) h.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0');
  return h.digest('hex');
};

const stage = (dest) => {
  cpSync(join(policy, 'simulation'), join(dest, 'simulation'), { recursive: true, filter: (s) => !s.endsWith('.gitkeep') });
  mkdirSync(join(dest, 'schemas'), { recursive: true });
  for (const n of SCHEMAS) cpSync(join(policy, 'schemas', `${n}.schema.json`), join(dest, 'schemas', `${n}.schema.json`));
};

if (process.argv.includes('--check')) {
  const tmp = join(root, 'test/simulation/fixtures/.check-tmp');
  rmSync(tmp, { recursive: true, force: true });
  try {
    stage(tmp);
    const same = existsSync(out) && hashTree(tmp) === hashTree(out);
    console.log(same ? 'sim data: in sync with can_policy' : 'sim data: DRIFT, run npm run sim:sync');
    process.exitCode = same ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  rmSync(out, { recursive: true, force: true });
  stage(out);
  const git = (...a) => { try { return execFileSync('git', ['-C', policy, ...a], { encoding: 'utf8' }).trim(); } catch { return null; } };
  const dirty = (git('status', '--porcelain', '--', 'simulation', 'schemas') ?? '') !== '';
  const files = walk(out).length;
  writeFileSync(
    join(out, 'SOURCE.json'),
    JSON.stringify(
      {
        can_policy_sha: git('rev-parse', 'HEAD'),
        source_dirty: dirty,
        content_sha256: hashTree(out),
        files,
        note: dirty ? 'Snapshot of the can_policy working tree; simulation/ or schemas/ had uncommitted changes. Resync once can_policy is committed.' : 'Clean snapshot.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`synced ${files} files from can_policy (dirty: ${dirty})`);
}
