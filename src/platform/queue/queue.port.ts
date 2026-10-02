export const JOB_CLASSES = [
  'crisis',
  'prepub',
  'update',
  'async',
  'sample',
] as const;
export type JobClass = (typeof JOB_CLASSES)[number];
export const JOB_STATUSES = ['queued', 'running', 'done', 'dead'] as const;

export interface Random {
  /** [0, 1) */
  next(): number;
}
export class MathRandom implements Random {
  next(): number {
    return Math.random();
  }
}
export const RANDOM = Symbol('QueueRandom');

export interface EnqueueInput {
  queue: string;
  class: JobClass;
  /** Ids and small flags only. User content stays in its own tables. */
  payload: Record<string, unknown>;
  dedupeKey?: string;
  runAt?: Date;
  /** Lower runs first within a class. */
  priority?: number;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: string;
  queue: string;
  class: JobClass;
  priority: number;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  runAt: Date;
}

/**
 * The one job queue (background-jobs.md). 03-u14 can later be rebased onto this port instead of
 * keeping its own runner.
 */
export abstract class QueuePort {
  /** Idempotent by dedupeKey while a job with that key is queued or running. Returns the job id. */
  abstract enqueue(i: EnqueueInput, now?: Date): Promise<string>;
  /** Up to n due jobs, best first, each leased. A lapsed lease makes a running job claimable again. */
  abstract claim(queue: string, n: number, now?: Date): Promise<ClaimedJob[]>;
  /** False when the lease was lost (job reclaimed or already settled). */
  abstract ack(job: ClaimedJob): Promise<boolean>;
  /** `code` is a short machine code, never a message. Backoff, or dead plus a job.dead audit event. */
  abstract fail(job: ClaimedJob, code: string, now?: Date): Promise<boolean>;
}

export interface QueueMetrics {
  onClaimed?(job: ClaimedJob): void;
  onDead?(job: ClaimedJob, code: string): void;
}
export const QUEUE_METRICS = Symbol('QueueMetrics');
