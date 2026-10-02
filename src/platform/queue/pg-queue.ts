import { Inject, Injectable, Optional } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { AuditPort, assertNoSecretKeys } from '../audit/audit.service.js';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '../ports.js';
import { backoffMs } from './backoff.js';
import { QUEUE_CONFIG, type QueueConfig } from './queue.config.js';
import {
  QUEUE_METRICS,
  QueuePort,
  RANDOM,
  type ClaimedJob,
  type EnqueueInput,
  type JobClass,
  type QueueMetrics,
  type Random,
} from './queue.port.js';

const RANK = sql`case class when 'crisis' then 0 when 'prepub' then 1 when 'update' then 2 when 'async' then 3 else 4 end`;
const ORDER = sql`order by ${RANK}, priority, run_at`;
const CODE = /^[a-z0-9_.-]{1,64}$/;

type Row = {
  id: string;
  queue: string;
  class: JobClass;
  priority: number;
  payload: Record<string, unknown>;
  attempt: number;
  max_attempts: number;
  run_at: Date | string;
};
const toJob = (r: Row): ClaimedJob => ({
  id: r.id,
  queue: r.queue,
  class: r.class,
  priority: r.priority,
  payload: r.payload,
  attempt: r.attempt,
  maxAttempts: r.max_attempts,
  runAt: new Date(r.run_at),
});

@Injectable()
export class PgQueue extends QueuePort {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(RANDOM) private readonly rnd: Random,
    @Inject(QUEUE_CONFIG) private readonly cfg: QueueConfig,
    private readonly audit: AuditPort,
    @Optional() @Inject(QUEUE_METRICS) private readonly metrics?: QueueMetrics,
  ) {
    super();
  }

  async enqueue(i: EnqueueInput, now = this.clock.now()): Promise<string> {
    assertNoSecretKeys(i.payload, 'payload');
    const id = this.ids.next();
    const ins = await this.db.execute<{ id: string }>(sql`
      insert into job (id, queue, class, priority, payload, run_at, max_attempts, dedupe_key, created_at)
      values (${id}, ${i.queue}, ${i.class}, ${i.priority ?? 100}, ${JSON.stringify(i.payload)}::jsonb,
              ${i.runAt ?? now}, ${i.maxAttempts ?? 5}, ${i.dedupeKey ?? null}, ${now})
      on conflict (dedupe_key) where status in ('queued','running') do nothing
      returning id`);
    if (ins.rows[0]) return ins.rows[0].id;
    const ex = await this.db.execute<{ id: string }>(sql`
      select id from job where dedupe_key = ${i.dedupeKey} and status in ('queued','running')`);
    // ponytail: the holder may finish between the two statements; callers retry enqueue on this rare throw.
    if (!ex.rows[0]) throw new Error('queue dedupe race, retry enqueue');
    return ex.rows[0].id;
  }

  async claim(
    queue: string,
    n: number,
    now = this.clock.now(),
  ): Promise<ClaimedJob[]> {
    const dead: ClaimedJob[] = [];
    const claimed = await this.db.transaction(async (tx) => {
      // Lapsed leases that already used every attempt go dead instead of running again.
      const ex = await tx.execute<Row>(sql`
        update job set status = 'dead', last_error_code = 'lease_expired', lease_until = null
        where id in (select id from job where queue = ${queue} and status = 'running'
                     and lease_until < ${now} and attempt >= max_attempts for update skip locked)
        returning id, queue, class, priority, payload, attempt, max_attempts, run_at`);
      for (const r of ex.rows) {
        dead.push(toJob(r));
        await this.auditDead(tx, toJob(r), 'lease_expired', now);
      }
      if (n <= 0) return [];

      const due = sql`queue = ${queue} and attempt < max_attempts and
        ((status = 'queued' and run_at <= ${now}) or (status = 'running' and lease_until < ${now}))`;
      // Starvation guard: reserve floor(n * share) slots for async and sample work when it waits.
      const reserve = Math.floor(n * this.cfg.asyncMinShare);
      const picked: string[] = [];
      if (reserve > 0) {
        const a = await tx.execute<{ id: string }>(sql`
          select id from job where ${due} and class in ('async','sample')
          ${ORDER} limit ${reserve} for update skip locked`);
        picked.push(...a.rows.map((r) => r.id));
      }
      const skip: SQL = picked.length
        ? sql`and id not in (${sql.join(
            picked.map((x) => sql`${x}`),
            sql`,`,
          )})`
        : sql``;
      const b = await tx.execute<{ id: string }>(sql`
        select id from job where ${due} ${skip}
        ${ORDER} limit ${n - picked.length} for update skip locked`);
      picked.push(...b.rows.map((r) => r.id));
      if (!picked.length) return [];

      const up = await tx.execute<Row>(sql`
        update job set status = 'running', attempt = attempt + 1,
                       lease_until = ${new Date(now.getTime() + this.cfg.leaseMs)}
        where id in (${sql.join(
          picked.map((x) => sql`${x}`),
          sql`,`,
        )})
        returning id, queue, class, priority, payload, attempt, max_attempts, run_at`);
      return up.rows.map(toJob);
    });
    for (const d of dead) this.metrics?.onDead?.(d, 'lease_expired');
    const rank = (c: JobClass) =>
      ['crisis', 'prepub', 'update', 'async', 'sample'].indexOf(c);
    claimed.sort(
      (x, y) =>
        rank(x.class) - rank(y.class) ||
        x.priority - y.priority ||
        x.runAt.getTime() - y.runAt.getTime(),
    );
    for (const j of claimed) this.metrics?.onClaimed?.(j);
    return claimed;
  }

  async ack(job: ClaimedJob): Promise<boolean> {
    const r = await this.db.execute(sql`
      update job set status = 'done', lease_until = null
      where id = ${job.id} and attempt = ${job.attempt} and status = 'running'`);
    return (r.rowCount ?? 0) > 0;
  }

  async fail(
    job: ClaimedJob,
    code: string,
    now = this.clock.now(),
  ): Promise<boolean> {
    const c = CODE.test(code) ? code : 'unknown';
    const isDead = await this.db.transaction(async (tx) => {
      const cur = await tx.execute(sql`
        select 1 from job where id = ${job.id} and attempt = ${job.attempt} and status = 'running'
        for update`);
      if (!cur.rows.length) return null;
      if (job.attempt >= job.maxAttempts) {
        await tx.execute(sql`
          update job set status = 'dead', last_error_code = ${c}, lease_until = null where id = ${job.id}`);
        await this.auditDead(tx, job, c, now);
        return true;
      }
      const at = new Date(now.getTime() + backoffMs(job.attempt, this.rnd));
      await tx.execute(sql`
        update job set status = 'queued', last_error_code = ${c}, lease_until = null, run_at = ${at}
        where id = ${job.id}`);
      return false;
    });
    if (isDead) this.metrics?.onDead?.(job, c);
    return isDead !== null;
  }

  private auditDead(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    job: ClaimedJob,
    code: string,
    now: Date,
  ) {
    void now;
    return this.audit.record(tx, {
      action: 'job.dead',
      subjectType: 'job',
      subjectId: job.id,
      detail: {
        queue: job.queue,
        class: job.class,
        attempt: job.attempt,
        reason: code,
      },
    });
  }
}
