import { dirname, resolve, sep } from 'node:path';

const SIM = resolve(import.meta.dirname);
const IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g;

/** Violations: relative imports that leave test/simulation (except openapi/) or reach src/. */
export function violations(file: string, source: string): string[] {
  const bad: string[] = [];
  for (const m of source.matchAll(IMPORT)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // bare packages and node: are fine
    const target = resolve(dirname(file), spec);
    const inside = target === SIM || target.startsWith(SIM + sep);
    const openapi = target.startsWith(resolve(SIM, '../../openapi') + sep);
    if (!inside && !openapi) bad.push(`${file}: ${spec}`);
  }
  return bad;
}
