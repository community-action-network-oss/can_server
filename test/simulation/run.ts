import { parseArgs } from 'node:util';
import { run } from './runner/runner.ts';
import type { Mode } from './store/store.ts';

const { values: v } = parseArgs({
  options: {
    scenarios: { type: 'string', default: 'smoke' },
    seed: { type: 'string', default: '1' },
    mode: { type: 'string', default: 'deterministic' },
    'base-url': { type: 'string' },
    out: { type: 'string', default: 'test/simulation/runs' },
    pack: { type: 'string', default: 'none@0' },
    'allow-ci-stack': { type: 'boolean', default: false },
  },
});
if (!v['base-url']) throw new Error('--base-url is required');
if (!['deterministic', 'live', 'replay'].includes(v.mode!)) throw new Error('bad --mode');

console.log(
  await run({
    scenarios: v.scenarios!,
    seed: Number(v.seed),
    mode: v.mode as Mode,
    baseUrl: v['base-url'],
    outDir: v.out!,
    pack: v.pack!,
    allowCiStack: v['allow-ci-stack']!,
  }),
);
