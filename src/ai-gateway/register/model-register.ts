import { existsSync, readFileSync } from 'node:fs';
import { GatewayError } from '../domain/errors.js';

/** One model the gateway may route to. 09-u68 extends it with per-DP scores and the primary/fallback chain. */
export interface ModelEntry {
  id: string;
  provider: 'fake' | 'openrouter' | 'anthropic';
  free: boolean;
  tasks: readonly string[];
  languages: readonly string[];
  maxInput: number;
  costPerMtok: { in: number; out: number };
  region: string;
  retention: string;
  dataCollection: 'deny' | 'allow';
  /** ISO date after which the eval no longer counts; null for the fake. */
  evalExpiry: string | null;
  /** DP ids the model is eligible for; passing one DP never makes it eligible for another. */
  dpEligibility: readonly string[];
}

export const DEFAULT_REGISTER_PATH = 'config/model-register.json';

export const DEFAULT_REGISTER: readonly ModelEntry[] = [
  {
    id: 'fake-1',
    provider: 'fake',
    free: true,
    tasks: ['moderation', 'assist'],
    languages: ['en'],
    maxInput: 6000,
    costPerMtok: { in: 0, out: 0 },
    region: 'local',
    retention: 'none',
    dataCollection: 'deny',
    evalExpiry: null,
    dpEligibility: ['*'],
  },
];

const bad = (i: number, why: string): never => {
  throw new GatewayError('invalid_register', `entry ${i}: ${why}`);
};
const strs = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

export function parseRegister(raw: unknown): ModelEntry[] {
  if (!Array.isArray(raw) || !raw.length)
    throw new GatewayError('invalid_register', 'expected a non-empty array');
  const ids = new Set<string>();
  return raw.map((e: Record<string, unknown>, i) => {
    if (!e || typeof e !== 'object') return bad(i, 'not an object');
    if (typeof e.id !== 'string' || !e.id) bad(i, 'id');
    if (ids.has(e.id as string)) bad(i, 'duplicate id');
    ids.add(e.id as string);
    if (!['fake', 'openrouter', 'anthropic'].includes(e.provider as string))
      bad(i, 'provider');
    if (typeof e.free !== 'boolean') bad(i, 'free');
    if (!strs(e.tasks) || !e.tasks.length) bad(i, 'tasks');
    if (!strs(e.languages) || !e.languages.length) bad(i, 'languages');
    if (!Number.isInteger(e.maxInput) || (e.maxInput as number) <= 0)
      bad(i, 'maxInput');
    const c = e.costPerMtok as { in?: unknown; out?: unknown } | undefined;
    if (
      !c ||
      typeof c.in !== 'number' ||
      typeof c.out !== 'number' ||
      c.in < 0 ||
      c.out < 0
    )
      bad(i, 'costPerMtok');
    if (e.free && (c!.in !== 0 || c!.out !== 0)) bad(i, 'free but priced');
    if (typeof e.region !== 'string' || !e.region) bad(i, 'region');
    if (typeof e.retention !== 'string' || !e.retention) bad(i, 'retention');
    if (e.dataCollection !== 'deny' && e.dataCollection !== 'allow')
      bad(i, 'dataCollection');
    if (
      e.evalExpiry !== null &&
      (typeof e.evalExpiry !== 'string' ||
        Number.isNaN(Date.parse(e.evalExpiry)))
    )
      bad(i, 'evalExpiry');
    if (e.provider !== 'fake' && e.evalExpiry === null)
      bad(i, 'live model needs evalExpiry');
    if (!strs(e.dpEligibility)) bad(i, 'dpEligibility');
    return e as unknown as ModelEntry;
  });
}

/** A missing file is the built-in fake-1 register only at the default path; an explicit path must exist. */
export function loadRegister(path: string): ModelEntry[] {
  if (!existsSync(path)) {
    if (path === DEFAULT_REGISTER_PATH) return [...DEFAULT_REGISTER];
    throw new GatewayError('invalid_register', 'file not found');
  }
  try {
    return parseRegister(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    throw new GatewayError('invalid_register', 'file does not parse');
  }
}
