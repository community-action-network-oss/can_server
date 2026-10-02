import { config } from '../../config.js';

const num = (v: string | undefined, d: number) =>
  v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v);

// ponytail: lives here because src/config.ts is outside this unit's WRITES; fold into config.ts later.
export const queueConfig = {
  jobsEnabled: process.env.JOBS_ENABLED
    ? process.env.JOBS_ENABLED === 'true'
    : config.nodeEnv !== 'test',
  concurrency: num(process.env.JOBS_CONCURRENCY, 4),
  pollMs: num(process.env.JOBS_POLL_MS, 1000),
  leaseMs: num(process.env.JOBS_LEASE_MS, 60_000),
  /** Share of each claim batch reserved for async and sample work when it waits. */
  asyncMinShare: num(process.env.JOBS_ASYNC_MIN_SHARE, 0.2),
};
export type QueueConfig = typeof queueConfig;
export const QUEUE_CONFIG = Symbol('QueueConfig');
