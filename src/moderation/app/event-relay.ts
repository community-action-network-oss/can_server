import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import { queueConfig } from '../../platform/queue/queue.config.js';
import { QueuePort } from '../../platform/queue/queue.port.js';
import { PolicyUnavailable } from '../../policy/domain/pack.js';
import { DP_IDS } from '../domain/outcome.js';
import type { ContentType } from '../domain/selector/events.js';
import { selectDps } from '../domain/selector/select.js';
import { RelayCursor } from '../infra/relay-cursor.js';
import { DpRegistry } from './dp-registry.js';
import {
  MODERATION_QUEUE,
  TRIGGER_BY_EVENT,
  mapProblemEvent,
  mapStageEvent,
  type Mapped,
  type ModerationJob,
  type RelaySource,
} from './events.js';

/**
 * ponytail: ids are v7 but commit order can differ from id order by a transaction's length; events younger than
 * this are left for the next tick. A transaction longer than this could still be skipped; move to a sequence column then.
 */
const GRACE_MS = 5000;
const BATCH = 200;

type Pe = {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  target_id: string;
  target_version: number;
  state: string;
  jurisdiction_id: string | null;
};
type Me = { id: string; type: string; payload: Record<string, unknown> };

export interface TickResult {
  seen: number;
  enqueued: number;
  ignored: number;
}

/**
 * Turns new append-only events into one deduped job per (event, DP). At-least-once: enqueue first, then
 * move the cursor, so a crash between them only re-enqueues, which the dedupe key absorbs while the job is open.
 */
@Injectable()
export class EventRelay
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly log = new Logger('EventRelay');
  private timer?: NodeJS.Timeout;
  private busy = false;
  /** Debug counter: event types no selector kind maps to. */
  ignoredTotal = 0;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly queue: QueuePort,
    private readonly cursor: RelayCursor,
    private readonly registry: DpRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!queueConfig.jobsEnabled) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.tick()
        .catch((e: Error) => this.log.error(`relay tick failed: ${e.message}`))
        .finally(() => (this.busy = false));
    }, queueConfig.pollMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** The writer of the two platform-level events (append-only, protocol_version and origin node stamped). */
  async emit(
    type: 'policy_changed' | 'sample_tick',
    payload: Record<string, string>,
    now = this.clock.now(),
  ): Promise<string> {
    const id = this.ids.next();
    await this.db.execute(sql`
      insert into moderation_event (id, type, payload, origin_node_id, protocol_version, occurred_at)
      values (${id}, ${type}, ${JSON.stringify(payload)}::jsonb, ${config.nodeId}, ${PROTOCOL_VERSION}, ${now})`);
    return id;
  }

  /** `cursor` names the cursor family (tests use their own so they never share a position). */
  async tick(o: { now?: Date; cursor?: string } = {}): Promise<TickResult> {
    const now = o.now ?? this.clock.now();
    const name = o.cursor ?? 'moderation';
    const cutoff = new Date(now.getTime() - GRACE_MS);
    const r: TickResult = { seen: 0, enqueued: 0, ignored: 0 };
    for (const source of [
      'problem_event',
      'stage_event',
      'moderation_event',
    ] as const)
      await this.cursor.advance(
        `${name}:${source}`,
        source,
        async (after, tx) => {
          const rows = await this.read(tx, source, after, cutoff);
          for (const row of rows) {
            r.seen++;
            r.enqueued += await this.handle(source, row, r);
          }
          return rows.length ? rows[rows.length - 1]!.id : null;
        },
      );
    this.ignoredTotal += r.ignored;
    return r;
  }

  private async read(
    tx: Parameters<Parameters<RelayCursor['advance']>[2]>[1],
    source: RelaySource,
    after: string,
    cutoff: Date,
  ): Promise<(Pe | Me)[]> {
    if (source === 'moderation_event')
      return (
        await tx.execute<Me>(sql`
          select id, type, payload from moderation_event
          where id > ${after} and occurred_at <= ${cutoff} order by id limit ${BATCH}`)
      ).rows;
    if (source === 'problem_event')
      return (
        await tx.execute<Pe>(sql`
          select e.id, e.type, e.payload, p.id as target_id, p.version as target_version, p.state,
                 p.jurisdiction_id
          from problem_event e join problem p on p.id = e.problem_id
          where e.id > ${after} and e.occurred_at <= ${cutoff} order by e.id limit ${BATCH}`)
      ).rows;
    return (
      await tx.execute<Pe>(sql`
        select e.id, e.type, e.payload, s.id as target_id, s.plan_version as target_version, s.state,
               p.jurisdiction_id
        from stage_event e join stage s on s.id = e.stage_id join problem p on p.id = e.problem_id
        where e.id > ${after} and e.occurred_at <= ${cutoff} order by e.id limit ${BATCH}`)
    ).rows;
  }

  private async handle(
    source: RelaySource,
    row: Pe | Me,
    r: TickResult,
  ): Promise<number> {
    if (source === 'moderation_event') return this.handleModeration(row as Me);
    const e = row as Pe;
    const m: Mapped | null =
      source === 'problem_event'
        ? mapProblemEvent(e.type, e.payload)
        : mapStageEvent(e.type);
    if (!m) {
      r.ignored++;
      return 0;
    }
    const targetKind: ContentType =
      source === 'problem_event' ? 'problem' : 'stage';
    const packDps = await this.packDps(e.jurisdiction_id);
    const stageIds = Array.isArray(e.payload?.stageIds)
      ? (e.payload.stageIds as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        )
      : undefined;
    let n = 0;
    for (const d of selectDps({
      event: m.kind,
      contentType: targetKind,
      state: e.state,
      changedFields: m.changedFields,
      packDps,
    })) {
      const job: ModerationJob = {
        v: 1,
        kind: 'dp',
        source,
        eventId: e.id,
        eventKind: m.kind,
        trigger: TRIGGER_BY_EVENT[m.kind],
        priorityClass: d.priorityClass,
        dpId: d.dpId,
        mode: d.mode,
        fields: d.fields,
        reusePrior: d.reusePrior,
        targetKind,
        targetId: e.target_id,
        targetVersion: e.target_version,
        jurisdictionId: e.jurisdiction_id,
        ...(d.missing && { holdReason: 'pack_missing' as const }),
        ...(stageIds && { stageIds }),
      };
      await this.put(job, `${e.id}:${d.dpId}`);
      n++;
    }
    return n;
  }

  private async handleModeration(e: Me): Promise<number> {
    const p = e.payload;
    const str = (k: string) =>
      typeof p[k] === 'string' ? (p[k] as string) : undefined;
    if (e.type === 'policy_changed') {
      // One fan-out job; the policy-change unit expands it into per-item rechecks.
      await this.put(
        {
          v: 1,
          kind: 'policy_fanout',
          source: 'moderation_event',
          eventId: e.id,
          eventKind: 'policy_changed',
          trigger: 'policy_change',
          priorityClass: 'async',
          fromVersion: str('fromVersion'),
          toVersion: str('toVersion'),
          scope: str('scope'),
        },
        `${e.id}:fanout`,
      );
      return 1;
    }
    const dpId = str('dpId');
    if (e.type !== 'sample_tick' || !dpId) return 0;
    const jurisdictionId = str('jurisdictionId') ?? null;
    const missing = !(await this.packDps(jurisdictionId)).has(dpId);
    await this.put(
      {
        v: 1,
        kind: 'dp',
        source: 'moderation_event',
        eventId: e.id,
        eventKind: 'sample_tick',
        trigger: 'sample',
        priorityClass: 'sample',
        dpId,
        mode: 'async',
        jurisdictionId,
        windowId: str('windowId'),
        ...(missing && { holdReason: 'pack_missing' as const }),
      },
      `${e.id}:${dpId}`,
    );
    return 1;
  }

  private async put(job: ModerationJob, dedupeKey: string): Promise<void> {
    await this.queue.enqueue({
      queue: MODERATION_QUEUE,
      class: job.priorityClass,
      payload: { ...job },
      dedupeKey,
    });
  }

  /** DP ids with a usable pack section. No active pack means none: every DP is missing and holds (fail closed). */
  private async packDps(jurisdictionId: string | null): Promise<Set<string>> {
    let key = 'default';
    if (jurisdictionId) {
      const j = await this.db.execute<{ name: string }>(
        sql`select name from jurisdiction where id = ${jurisdictionId}`,
      );
      key = j.rows[0]?.name ?? 'default';
    }
    try {
      const view = await this.registry.forJurisdiction(key);
      const gone = new Set<string>(view.missing);
      return new Set(DP_IDS.filter((d) => !gone.has(d)));
    } catch (e) {
      if (e instanceof PolicyUnavailable) return new Set();
      throw e;
    }
  }
}
