import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuthService } from '../accounts/app/auth.service.js';
import { config } from '../config.js';
import { isPublicState, type State } from '../domain/lifecycle/vocabulary.js';
import { RelayCursor } from '../moderation/infra/relay-cursor.js';
import { log } from '../platform/logging/logger.js';
import { followUpdate } from '../platform/mail/templates.js';
import { CLOCK, type Clock } from '../platform/ports.js';
import { queueConfig } from '../platform/queue/queue.config.js';
import {
  EXPLANATION,
  PURPOSE,
  mapProblemEvent,
  mapStageEvent,
  type Mapped,
} from './notification-kinds.js';
import { DB, type Db } from '../db/db.module.js';

/** Same grace as the moderation relay: v7 ids can commit slightly out of order. */
const GRACE_MS = 5000;
const BATCH = 200;

type Row = {
  id: string;
  type: string;
  to_state: string | null;
  payload: Record<string, unknown> | null;
  problem_id: string;
  occurred_at: Date;
  state: string;
  withdrawn_published: boolean;
};
type Mail = { accountId: string; problemId: string; m: Mapped };

/**
 * Follower notifications (04-u07). Reads the append-only event tables after commit through a cursor, so a
 * fan-out failure can never roll back a lifecycle change. Followers come only from the follow table (opt-in,
 * D-80); nothing here sees interests or the capability profile. Ids and fixed labels only.
 */
@Injectable()
export class NotificationFanout
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('NotificationFanout');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly cursor: RelayCursor,
    private readonly accounts: AuthService,
  ) {}

  onApplicationBootstrap(): void {
    if (!queueConfig.jobsEnabled) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.tick()
        .catch((e: Error) =>
          this.logger.error(`fan-out tick failed: ${e.message}`),
        )
        .finally(() => (this.busy = false));
    }, queueConfig.pollMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** `cursor` names the cursor family (tests use their own). Resolves after the emails were handed over. */
  async tick(o: { now?: Date; cursor?: string } = {}): Promise<number> {
    const now = o.now ?? this.clock.now();
    const name = o.cursor ?? 'notifications';
    const cutoff = new Date(now.getTime() - GRACE_MS);
    const mails: Mail[] = [];
    let made = 0;
    for (const source of ['problem_event', 'stage_event'] as const)
      await this.cursor.advance(
        `${name}:${source}`,
        source,
        async (after, tx) => {
          const rows = (
            await tx.execute<Row>(sql`
            select e.id, e.type, e.to_state, e.payload, e.problem_id, e.occurred_at, p.state, p.withdrawn_published
            from ${sql.raw(source)} e join problem p on p.id = e.problem_id
            where e.id > ${after} and e.occurred_at <= ${cutoff} order by e.id limit ${BATCH}`)
          ).rows;
          for (const r of rows) {
            const m =
              source === 'problem_event'
                ? mapProblemEvent(camel(r))
                : mapStageEvent(camel(r));
            if (!m || !isPublicState(r.state as State, r.withdrawn_published))
              continue;
            // Followers who followed before the event, not muted. Consent is checked against the live record.
            const ins = await tx.execute<{
              account_id: string;
              mail: boolean;
            }>(sql`
            insert into notification (id, account_id, problem_id, kind, event_id, label, created_at)
            select gen_random_uuid(), f.account_id, f.problem_id, ${m.kind}, ${r.id}, ${m.label}, ${now}
            from follow f
            where f.problem_id = ${r.problem_id} and f.muted_at is null and f.created_at <= ${r.occurred_at}
            on conflict (account_id, event_id) do nothing
            returning account_id,
              exists (select 1 from follow f2 where f2.account_id = notification.account_id
                        and f2.problem_id = notification.problem_id and f2.mail_consent_at is not null)
              and exists (select 1 from consent_record c where c.account_id = notification.account_id
                        and c.purpose = ${PURPOSE} and c.revoked_at is null) as mail`);
            made += ins.rows.length;
            for (const i of ins.rows)
              if (i.mail)
                mails.push({
                  accountId: i.account_id,
                  problemId: r.problem_id,
                  m,
                });
          }
          return rows.length ? rows[rows.length - 1]!.id : null;
        },
      );
    for (const x of mails) await this.mail(x);
    return made;
  }

  /** Never rejects and never logs the address (IDENT-1). */
  private async mail({ accountId, problemId, m }: Mail): Promise<void> {
    try {
      await this.accounts.sendToAccount(accountId, {
        ...followUpdate({
          label: m.label,
          explanation: EXPLANATION[m.kind],
          link: `${config.appBaseUrl}/problems/${problemId}`,
          manageLink: `${config.appBaseUrl}/me/follows`,
        }),
        kind: 'follow_update',
      });
    } catch (e) {
      log('error', 'follow_mail_failed', {
        problemId,
        reason: e instanceof Error ? e.name : typeof e,
      });
    }
  }
}

const camel = (r: Row) => ({
  type: r.type,
  toState: r.to_state,
  payload: r.payload,
});
