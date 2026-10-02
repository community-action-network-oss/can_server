import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/ports.js';
import { queueConfig } from '../../../platform/queue/queue.config.js';
import { QueuePort } from '../../../platform/queue/queue.port.js';
import { QueueWorker } from '../../../platform/queue/worker.js';
import { RunRecorder } from '../../../moderation/app/run-recorder.js';
import { TokenStore } from '../../infra/token-store.js';

export const PURGE_QUEUE = 'privacy.purge_tokens';
export const PURGE_EVERY_MS = 5 * 60 * 1000;

/**
 * Retention for the pseudonym token store: a periodic deduped job purges expired rows, and a finished run
 * (complete, hold, fail) purges its own mapping at once. Both only run when jobs are enabled.
 */
@Injectable()
export class TokenRetention
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly log = new Logger('TokenRetention');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly tokens: TokenStore,
    private readonly queue: QueuePort,
    private readonly worker: QueueWorker,
    private readonly recorder: RunRecorder,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    if (!queueConfig.jobsEnabled) return;
    this.worker.register(PURGE_QUEUE, async () => {
      await this.tokens.purgeExpiredTokens(this.clock.now());
    });
    this.recorder.onFinished((runId) => this.tokens.purgeOperation(runId));
    const tick = () =>
      this.enqueue().catch((e: Error) =>
        this.log.error(`purge enqueue failed: ${e.message}`),
      );
    void tick();
    this.timer = setInterval(tick, PURGE_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Deduped while a purge job is queued or running, so ticks never pile up. */
  enqueue(): Promise<string> {
    return this.queue.enqueue(
      {
        queue: PURGE_QUEUE,
        class: 'async',
        payload: {},
        dedupeKey: PURGE_QUEUE,
      },
      this.clock.now(),
    );
  }
}
