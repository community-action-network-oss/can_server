import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { violations } from './boundary.ts';

const files = (readdirSync(import.meta.dirname, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.ts') && !f.startsWith('runs'))
  .map((f) => join(import.meta.dirname, f));

describe('simulation import boundary (SIM-NOSECRET-1)', () => {
  it('no harness file imports server code', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.flatMap((f) => violations(f, readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('red: a src import is caught', () => {
    const bad = "import { x } from '" + '../../src/domain/ids.js' + "';";
    expect(violations(join(import.meta.dirname, 'runner/x.ts'), bad)).toHaveLength(1);
  });

  it('green: bare and inside imports pass', () => {
    const ok = "import { v7 } from 'uuid';\nimport { a } from '" + '../store/store.ts' + "';";
    expect(violations(join(import.meta.dirname, 'runner/x.ts'), ok)).toEqual([]);
  });
});
