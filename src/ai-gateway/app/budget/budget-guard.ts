import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../../../db/db.module.js';
import { spendAlert, spendLedger } from '../../../db/schema.js';
import type { Tx } from '../../../db/tx.js';
import { newId } from '../../../domain/ids.js';
import { CLOCK, type Clock } from '../../../platform/ports.js';
import { ProviderError } from '../../providers/errors.js';
import { ALERT_PORT, type AlertPort } from './alert-port.js';
import { CAPS_TOKEN } from './budget.tokens.js';
import type { Caps } from './caps.js';

/** Shed order, first to go first. `blocking` is held, never weakened. */
export const SHED_ORDER = [
  'sample',
  'remoderation',
  'update_lowrisk',
  'blocking',
] as const;
export type WorkClass = (typeof SHED_ORDER)[number];

/** A class is shed once projected usage of any cap reaches this share (blocking: only past 100%). */
export const SHED_AT: Record<WorkClass, number> = {
  sample: 0.8,
  remoderation: 0.9,
  update_lowrisk: 0.95,
  blocking: 1,
};
/** A per-run budget stops its run at this share. */
export const RUN_STOP_AT = 0.95;
const LEVELS = [50, 80, 100] as const;

export interface CheckInput {
  dpId: string;
  jurisdictionId?: string | null;
  eventId?: string | null;
  /** Per-run budget scope (record, persona, eval runs): both set, or neither. */
  runId?: string;
  runBudgetMicroUsd?: number;
  estimateMicroUsd: number;
  workClass: WorkClass;
}
export type BudgetVerdict =
  'allow' | { deny: 'budget_exhausted'; shed: WorkClass; cap: string };

export interface RecordInput {
  dpId: string;
  jurisdictionId?: string | null;
  eventId?: string | null;
  runId: string;
  /** From costMicroUsd(); 0 for free models, which still count toward the call cap. */
  costMicroUsd: number;
}

interface CapUse {
  key: string;
  used: number;
  cap: number;
}

/** Pure: which cap, if any, denies this class. Blocking is denied only above 100%, others at their shed share. */
export function decide(
  workClass: WorkClass,
  uses: CapUse[],
  run?: CapUse,
): { deny: true; cap: string } | { deny: false } {
  if (run && run.used / run.cap >= RUN_STOP_AT)
    return { deny: true, cap: run.key };
  for (const u of uses) {
    const r = u.used / u.cap;
    if (workClass === 'blocking' ? r > 1 : r >= SHED_AT[workClass])
      return { deny: true, cap: u.key };
  }
  return { deny: false };
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (d: Date) => `${d.toISOString().slice(0, 7)}-01`;

@Injectable()
export class BudgetGuard {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CAPS_TOKEN) private readonly caps: Caps,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
  ) {}

  /** Fail closed: a read error propagates, and the caller maps any throw to hold. */
  async check(input: CheckInput, q: Db | Tx = this.db): Promise<BudgetVerdict> {
    const now = this.clock.now();
    const t = await this.totals(q, now, input);
    const uses = this.uses(t, input, input.estimateMicroUsd, 1);
    const run =
      input.runId && input.runBudgetMicroUsd
        ? {
            key: `run:${input.runId}`,
            used: t.run + input.estimateMicroUsd,
            cap: input.runBudgetMicroUsd,
          }
        : undefined;
    const v = decide(input.workClass, uses, run);
    return v.deny
      ? { deny: 'budget_exhausted', shed: input.workClass, cap: v.cap }
      : 'allow';
  }

  /** Writes the ledger row in the caller's run transaction, then raises any newly crossed alert levels. */
  async record(tx: Tx, input: RecordInput): Promise<void> {
    const now = this.clock.now();
    const day = dayOf(now);
    await tx.insert(spendLedger).values({
      id: newId(),
      day,
      jurisdictionId: input.jurisdictionId ?? null,
      dpId: input.dpId,
      eventId: input.eventId ?? null,
      runId: input.runId,
      costMicroUsd: input.costMicroUsd,
      createdAt: now,
    });
    const t = await this.totals(tx, now, input);
    for (const u of this.uses(t, input, 0, 0)) {
      for (const level of LEVELS) {
        if (u.used * 100 < level * u.cap) continue;
        const fresh = await tx
          .insert(spendAlert)
          .values({ capKey: u.key, level, day, createdAt: now })
          .onConflictDoNothing()
          .returning({ level: spendAlert.level });
        if (fresh.length)
          this.alerts.emit({
            capKey: u.key,
            level,
            day,
            usedMicroUsd: u.used,
            capMicroUsd: u.cap,
          });
      }
    }
  }

  private uses(
    t: Totals,
    i: { eventId?: string | null },
    est: number,
    calls: number,
  ): CapUse[] {
    const c = this.caps;
    const out: CapUse[] = [
      { key: 'monthly', used: t.month + est, cap: c.monthly },
      { key: 'daily', used: t.day + est, cap: c.daily },
      { key: 'daily_calls', used: t.calls + calls, cap: c.dailyCalls },
      { key: 'dp', used: t.dp + est, cap: c.perDp },
      { key: 'jurisdiction', used: t.jur + est, cap: c.perJurisdiction },
    ];
    if (i.eventId)
      out.push({
        key: `event:${i.eventId}`,
        used: t.event + est,
        cap: c.perEvent,
      });
    return out;
  }

  private async totals(
    q: Db | Tx,
    now: Date,
    i: {
      dpId: string;
      jurisdictionId?: string | null;
      eventId?: string | null;
      runId?: string;
    },
  ): Promise<Totals> {
    const day = dayOf(now);
    const m0 = monthStart(now);
    const nextM = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    )
      .toISOString()
      .slice(0, 10);
    const s = (f: ReturnType<typeof sql>) =>
      sql`coalesce(sum(cost_micro_usd) filter (where ${f}), 0)::text`;
    const today = sql`day = ${day}::date`;
    const r = await q.execute<Record<string, string>>(sql`
      select
        ${s(sql`day >= ${m0}::date and day < ${nextM}::date`)} as month,
        ${s(today)} as day,
        (count(*) filter (where ${today}))::text as calls,
        ${s(sql`${today} and dp_id = ${i.dpId}`)} as dp,
        ${s(sql`${today} and jurisdiction_id = ${i.jurisdictionId ?? null}::uuid`)} as jur,
        ${s(sql`event_id = ${i.eventId ?? null}`)} as event,
        ${s(sql`run_id = ${i.runId ?? null}::uuid`)} as run
      from spend_ledger
      where day >= ${m0}::date and day < ${nextM}::date or run_id = ${i.runId ?? null}::uuid
    `);
    const row = r.rows[0]!;
    return Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, Number(v)]),
    ) as unknown as Totals;
  }
}

interface Totals {
  month: number;
  day: number;
  calls: number;
  dp: number;
  jur: number;
  event: number;
  run: number;
}

/** Hard latency budget: a stage that outlives it surfaces as ProviderError('timeout'), which maps to hold. */
export async function withStageTimeout<T>(
  work: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new ProviderError('timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
