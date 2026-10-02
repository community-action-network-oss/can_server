import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FRAMINGS } from './framings.js';

const flow = '../docs/design/flows/seed-bootstrap.md';
const decisions = '../DECISIONS.md';

describe('framings', () => {
  it('has four seeds', () =>
    expect(FRAMINGS.map((f) => f.seed)).toEqual([1, 2, 3, 4]));
  // The superproject is absent in a standalone can_server checkout; skip rather than fail there.
  it.skipIf(!existsSync(flow))(
    'seeds 1 and 2 match the flow doc verbatim',
    () => {
      const doc = readFileSync(flow, 'utf8');
      for (const f of FRAMINGS.slice(0, 2)) expect(doc).toContain(f.text);
    },
  );
  it.skipIf(!existsSync(decisions))('names match D-56', () => {
    const doc = readFileSync(decisions, 'utf8');
    for (const f of FRAMINGS) expect(doc).toContain(f.name);
  });
});
