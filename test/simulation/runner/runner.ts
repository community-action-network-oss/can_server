import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ApiClient } from '../api/client.ts';
import { loadScenarioSet } from '../scenarios/index.ts';
import { makeRunId, RunStore, type Mode } from '../store/store.ts';

export interface RunOptions {
  scenarios: string;
  seed: number;
  mode: Mode;
  baseUrl: string;
  outDir: string;
  pack: string;
  allowCiStack: boolean;
  env?: NodeJS.ProcessEnv;
  newRunId?: () => string;
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Persona-visible env: only SIM_TOKEN_* keys. Never DATABASE_URL, ANTHROPIC_API_KEY, SMTP_*. */
export const personaEnv = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(([k, v]) => k.startsWith('SIM_TOKEN_') && v !== undefined),
  ) as Record<string, string>;

/** Refuse unless the stack says it is a simulation stack (or CI stack on localhost). */
export async function guard(baseUrl: string, allowCiStack: boolean): Promise<void> {
  if (allowCiStack) {
    if (!LOCAL.has(new URL(baseUrl).hostname)) {
      throw new Error('--allow-ci-stack requires a localhost base url');
    }
    return;
  }
  let simulation = false;
  try {
    const res = await fetch(new URL('/v1/health', baseUrl));
    simulation = ((await res.json()) as { simulation?: unknown }).simulation === true;
  } catch {
    // unreachable counts as not a simulation stack
  }
  if (!simulation) throw new Error(`${baseUrl} is not marked as a simulation stack (health.simulation)`);
}

const gitSha = (): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

export async function run(o: RunOptions): Promise<string> {
  await guard(o.baseUrl, o.allowCiStack);
  const personas = loadScenarioSet(o.scenarios);
  const runId = makeRunId(o.newRunId);
  const store = new RunStore(join(o.outDir, runId), {
    run_id: runId,
    mode: o.mode,
    seed: o.seed,
    base_url: o.baseUrl,
    pack: o.pack,
    schema_version: '1',
    scenarios: o.scenarios,
    harness_git_sha: gitSha(),
    started_at: new Date().toISOString(),
    ended_at: null,
  });
  const tokens = personaEnv(o.env ?? process.env);
  for (const p of personas) {
    await p.run(new ApiClient(o.baseUrl, p.id, store, tokens[`SIM_TOKEN_${p.id.toUpperCase()}`]));
  }
  store.finish();
  return store.dir;
}
