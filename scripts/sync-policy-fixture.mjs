// Refreshes test/fixtures/policy-v1 from the sibling can_policy repo (D-82). Stdlib only.
// No sibling repo: exit 0 and keep the committed copy. Tests never read ../can_policy.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tool = join(root, '../can_policy/tools/export-fixture.mjs');
if (!existsSync(tool)) {
  console.log('skipped: can_policy not present');
  process.exit(0);
}
const r = spawnSync(
  process.execPath,
  [tool, '--out', join(root, 'test/fixtures/policy-v1')],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
