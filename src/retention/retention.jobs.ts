import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AuthRetention } from '../accounts/app/retention.js';
import { CLOCK, type Clock } from '../platform/ports.js';
import { queueConfig } from '../platform/queue/queue.config.js';
import { QueuePort } from '../platform/queue/queue.port.js';
import { QueueWorker } from '../platform/queue/worker.js';
import { FingerprintRepo } from '../problems/infra/fingerprint.repo.js';
import { ProblemRetention } from '../problems/app/retention.js';

export const TICK_MS = 15 * 60 * 1000;
/** Lower runs first; maintenance yields to everything else in the async class. */
const PRIORITY = 100;

/** Queue name to job body. Bodies are plain `(now) => ...`, so tests call them directly. */
export const RETENTION_JOBS = [
  'retention.purge_drafts',
  'retention.fingerprints',
  'retention.auth',
  'retention.idle_revisions',
] as const;

/**
 * 03-u14. A periodic tick only enqueues one deduped job per kind and window; the shared queue claims
 * rows, so two instances never run the same job. Payloads hold the window only.
 */
@Injectable()
export class RetentionJobs
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly log = new Logger('RetentionJobs');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly problems: ProblemRetention,
    private readonly auth: AuthRetention,
    @Inject(FingerprintRepo) private readonly fingerprints: FingerprintRepo,
    private readonly queue: QueuePort,
    private readonly worker: QueueWorker,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    if (!queueConfig.jobsEnabled) return;
    const [purge, fp, auth, idle] = RETENTION_JOBS;
    const now = () => this.clock.now();
    this.worker.register(purge, async () => {
      await this.problems.purgeDrafts(now());
    });
    this.worker.register(fp, async () => {
      await this.fingerprints.purgeExpired(now());
    });
    this.worker.register(auth, async () => {
      await this.auth.cleanupAuth(now());
    });
    this.worker.register(idle, async () => {
      await this.problems.idleRevisions(now());
    });
    const tick = () =>
      this.enqueueAll().catch((e: Error) =>
        this.log.error(`retention enqueue failed: ${e.message}`),
      );
    void tick();
    this.timer = setInterval(tick, TICK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Deduped per kind and window, so repeated or concurrent ticks add nothing. */
  async enqueueAll(): Promise<string[]> {
    const now = this.clock.now();
    const window = Math.floor(now.getTime() / TICK_MS);
    return Promise.all(
      RETENTION_JOBS.map((queue) =>
        this.queue.enqueue(
          {
            queue,
            class: 'async',
            priority: PRIORITY,
            payload: { window },
            dedupeKey: `${queue}:${window}`,
          },
          now,
        ),
      ),
    );
  }
}
