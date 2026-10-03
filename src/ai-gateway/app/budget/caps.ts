import { config } from '../../../config.js';

const MICRO = 1_000_000;

/** All amounts micro-USD; `dailyCalls` counts ledger rows (free calls included). */
export interface Caps {
  monthly: number;
  daily: number;
  perDp: number;
  perJurisdiction: number;
  perEvent: number;
  dailyCalls: number;
  /** Hard stage timeout; surfaces as ProviderError('timeout'), which the gateway maps to hold. */
  stageTimeoutMs: number;
}

/** Documented defaults (USD, calls, ms) for a $10 per month app. Env names mirror the monthly cap's AI_ prefix. */
export const CAP_DEFAULTS = {
  AI_DAILY_CAP_USD: 1,
  AI_DP_DAILY_CAP_USD: 0.25,
  AI_JURISDICTION_DAILY_CAP_USD: 0.5,
  AI_EVENT_CAP_USD: 0.05,
  AI_DAILY_CALL_CAP: 2000,
  AI_STAGE_TIMEOUT_MS: 45_000,
} as const;

/** Defensive read: a missing, non-numeric or non-positive value falls back to the default. */
const pos = (raw: string | undefined, fallback: number): number => {
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function loadCaps(
  env: Record<string, string | undefined> = process.env,
  monthlyUsd: number = config.ai.spendCapMonthlyUsd,
): Caps {
  const d = CAP_DEFAULTS;
  const usd = (k: keyof typeof d) => Math.round(pos(env[k], d[k]) * MICRO);
  return {
    monthly: Math.round(monthlyUsd * MICRO),
    daily: usd('AI_DAILY_CAP_USD'),
    perDp: usd('AI_DP_DAILY_CAP_USD'),
    perJurisdiction: usd('AI_JURISDICTION_DAILY_CAP_USD'),
    perEvent: usd('AI_EVENT_CAP_USD'),
    dailyCalls: Math.round(pos(env.AI_DAILY_CALL_CAP, d.AI_DAILY_CALL_CAP)),
    stageTimeoutMs: Math.round(
      pos(env.AI_STAGE_TIMEOUT_MS, d.AI_STAGE_TIMEOUT_MS),
    ),
  };
}
