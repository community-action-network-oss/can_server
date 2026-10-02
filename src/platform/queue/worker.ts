import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { QUEUE_CONFIG, type QueueConfig } from './queue.config.js';
import { QueuePort, type ClaimedJob } from './queue.port.js';

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/** Throw this from a handler to give the retry a stable, content-free error code. */
export class JobError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

@Injectable()
export class QueueWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly handlers = new Map<string, JobHandler>();
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly queue: QueuePort,
    @Inject(QUEUE_CONFIG) private readonly cfg: QueueConfig,
  ) {}

  register(queue: string, handler: JobHandler): void {
    if (this.handlers.has(queue))
      throw new Error(`handler already registered for queue ${queue}`);
    this.handlers.set(queue, handler);
  }

  onApplicationBootstrap(): void {
    if (!this.cfg.jobsEnabled) return;
    this.timer = setInterval(() => {
      for (const q of this.handlers.keys()) this.track(this.drain(q));
    }, this.cfg.pollMs);
    this.timer.unref();
  }

  /** SIGTERM: stop polling, let running handlers settle. */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.inflight);
  }

  /** Runs due jobs of one queue until none are left; returns how many were handled. */
  async drain(queue: string): Promise<number> {
    const handler = this.handlers.get(queue);
    if (!handler) throw new Error(`no handler for queue ${queue}`);
    let handled = 0;
    while (!this.stopping) {
      const batch = await this.queue.claim(queue, this.cfg.concurrency);
      if (!batch.length) break;
      await Promise.all(batch.map((j) => this.run(handler, j)));
      handled += batch.length;
    }
    return handled;
  }

  private async run(handler: JobHandler, job: ClaimedJob): Promise<void> {
    try {
      await handler(job);
    } catch (e) {
      await this.queue.fail(
        job,
        e instanceof JobError ? e.code : 'handler_error',
      );
      return;
    }
    await this.queue.ack(job);
  }

  private track(p: Promise<unknown>): void {
    const t = p.catch(() => undefined).finally(() => this.inflight.delete(t));
    this.inflight.add(t);
  }
}
