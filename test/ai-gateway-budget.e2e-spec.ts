import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AlertPort,
  SpendAlert,
} from '../src/ai-gateway/app/budget/alert-port.js';
import {
  BudgetGuard,
  withStageTimeout,
  type CheckInput,
} from '../src/ai-gateway/app/budget/budget-guard.js';
import { loadCaps, type Caps } from '../src/ai-gateway/app/budget/caps.js';
import { config } from '../src/config.js';
import * as schema from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { FixedClock } from '../src/platform/testing.js';

let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
const alerts: SpendAlert[] = [];
const port: AlertPort = { emit: (a) => alerts.push(a) };

// The ledger is insert-only, so each run anchors in a random far-past month it owns.
const year = 1200 + Math.floor(Math.random() * 600);
const at = (month: number, day: number) =>
  new Date(Date.UTC(year, month, day, 12));
const clock = new FixedClock(at(0, 1));

const caps: Caps = {
  monthly: 1000,
  daily: 400,
  perDp: 10_000,
  perJurisdiction: 10_000,
  perEvent: 10_000,
  dailyCalls: 1000,
  stageTimeoutMs: 45_000,
};
const guard = (c: Partial<Caps> = {}) =>
  new BudgetGuard(db as never, clock, { ...caps, ...c }, port);

const spend = (
  g: BudgetGuard,
  o: Partial<Parameters<BudgetGuard['record']>[1]>,
) =>
  db.transaction((tx) =>
    g.record(tx, { dpId: 'DP-X', runId: newId(), costMicroUsd: 0, ...o }),
  );
const chk = (g: BudgetGuard, o: Partial<CheckInput> = {}) =>
  g.check({ dpId: 'DP-X', estimateMicroUsd: 1, workClass: 'blocking', ...o });

beforeAll(() => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  db = drizzle(pool, { schema });
});
afterAll(() => pool.end());

describe('BudgetGuard', () => {
  it('a per-event cap denies the next stage of that event only', async () => {
    clock.set(at(1, 1));
    const g = guard({ perEvent: 100 });
    const ev = newId();
    expect(await chk(g, { eventId: ev, estimateMicroUsd: 50 })).toBe('allow');
    await spend(g, { eventId: ev, costMicroUsd: 90 });
    expect(await chk(g, { eventId: ev, estimateMicroUsd: 20 })).toMatchObject({
      deny: 'budget_exhausted',
      shed: 'blocking',
    });
    expect(await chk(g, { eventId: newId(), estimateMicroUsd: 20 })).toBe(
      'allow',
    );
  });

  it('sheds in order: sample, re-moderation, low-risk updates, then blocking', async () => {
    clock.set(at(2, 1));
    const g = guard({ daily: 1000 });
    const verdicts = async () =>
      Promise.all(
        (['sample', 'remoderation', 'update_lowrisk', 'blocking'] as const).map(
          async (workClass) =>
            (await chk(g, { workClass, estimateMicroUsd: 0 })) === 'allow',
        ),
      );
    expect(await verdicts()).toEqual([true, true, true, true]);
    await spend(g, { costMicroUsd: 800 });
    expect(await verdicts()).toEqual([false, true, true, true]);
    await spend(g, { costMicroUsd: 100 });
    expect(await verdicts()).toEqual([false, false, true, true]);
    await spend(g, { costMicroUsd: 50 });
    expect(await verdicts()).toEqual([false, false, false, true]);
    await spend(g, { costMicroUsd: 100 });
    expect(await verdicts()).toEqual([false, false, false, false]);
  });

  it('alert levels fire once per cap per day and re-arm the next day', async () => {
    clock.set(at(3, 1));
    alerts.length = 0;
    const g = guard({ daily: 100, monthly: 100_000 });
    await spend(g, { costMicroUsd: 55 });
    await spend(g, { costMicroUsd: 1 });
    expect(
      alerts.filter((a) => a.capKey === 'daily').map((a) => a.level),
    ).toEqual([50]);
    await spend(g, { costMicroUsd: 30 });
    await spend(g, { costMicroUsd: 30 });
    await spend(g, { costMicroUsd: 30 });
    expect(
      alerts.filter((a) => a.capKey === 'daily').map((a) => a.level),
    ).toEqual([50, 80, 100]);
    clock.set(at(3, 2));
    await spend(g, { costMicroUsd: 60 });
    expect(alerts.filter((a) => a.capKey === 'daily')).toHaveLength(4);
  });

  it('day rollover resets daily totals; month rollover resets the monthly total', async () => {
    clock.set(at(4, 30));
    const g = guard({ daily: 100, monthly: 150 });
    await spend(g, { costMicroUsd: 100 });
    expect(await chk(g, { estimateMicroUsd: 10 })).not.toBe('allow'); // daily
    clock.set(at(5, 1)); // next month
    expect(await chk(g, { estimateMicroUsd: 10 })).toBe('allow');
    clock.set(at(4, 30));
    expect(await chk(g, { estimateMicroUsd: 60 })).not.toBe('allow'); // monthly 160 > 150
  });

  it('monthly total spans days of the month', async () => {
    clock.set(at(6, 1));
    const g = guard({ monthly: 100, daily: 1000 });
    await spend(g, { costMicroUsd: 70 });
    clock.set(at(6, 15));
    expect(await chk(g, { estimateMicroUsd: 40 })).not.toBe('allow');
    expect(await chk(g, { estimateMicroUsd: 20 })).toBe('allow');
  });

  it('a per-run budget stops its run at 95 percent, even for blocking work', async () => {
    clock.set(at(7, 1));
    const g = guard({ daily: 100_000, monthly: 100_000 });
    const runId = newId();
    const run = { runId, runBudgetMicroUsd: 1000 };
    await spend(g, { runId, costMicroUsd: 900 });
    expect(await chk(g, { ...run, estimateMicroUsd: 40 })).toBe('allow');
    expect(await chk(g, { ...run, estimateMicroUsd: 50 })).toMatchObject({
      deny: 'budget_exhausted',
    });
  });

  it('free calls cost 0 but count toward the call cap', async () => {
    clock.set(at(8, 1));
    const g = guard({ dailyCalls: 3 });
    await spend(g, { costMicroUsd: 0 });
    await spend(g, {});
    expect(await chk(g, { estimateMicroUsd: 0 })).toBe('allow');
    await spend(g, {});
    expect(await chk(g, { estimateMicroUsd: 0 })).toMatchObject({
      deny: 'budget_exhausted',
    });
  });

  it('the ledger is insert-only and a failed read rejects (fail closed)', async () => {
    await expect(
      pool.query('update spend_ledger set cost_micro_usd = 0'),
    ).rejects.toThrow(/insert-only/);
    await expect(pool.query('delete from spend_alert')).rejects.toThrow(
      /insert-only/,
    );
    const broken = new BudgetGuard(
      { execute: () => Promise.reject(new Error('db down')) } as never,
      clock,
      caps,
      port,
    );
    await expect(chk(broken)).rejects.toThrow();
  });
});

describe('caps and timeout', () => {
  it('defaults to $10 a month and reads garbage defensively', () => {
    expect(loadCaps({}, 10).monthly).toBe(10_000_000);
    const c = loadCaps(
      {
        AI_DAILY_CAP_USD: 'abc',
        AI_EVENT_CAP_USD: '-1',
        AI_STAGE_TIMEOUT_MS: '0',
      },
      10,
    );
    expect(c.daily).toBe(1_000_000);
    expect(c.perEvent).toBe(50_000);
    expect(c.stageTimeoutMs).toBe(45_000);
  });
  it('a stage that outlives the budget surfaces timeout', async () => {
    await expect(
      withStageTimeout(new Promise(() => {}), 10),
    ).rejects.toMatchObject({ code: 'timeout' });
    await expect(withStageTimeout(Promise.resolve(1), 10)).resolves.toBe(1);
  });
});
