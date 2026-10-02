import { Injectable } from '@nestjs/common';
import {
  assertEscalationAllowed,
  OUTCOMES,
  type Outcome,
} from '../domain/outcome.js';
import { HOLD_REASONS, type HoldReason } from '../domain/hold-reasons.js';
import {
  RunStore,
  type BeginInput,
  type BeginResult,
  type CompleteInput,
  type RunRow,
  type StageInput,
} from '../infra/run-store.js';

/** Stage outputs hold codes, ids, numbers and offsets only: any other string is raw text and is refused. */
const CODE = /^[A-Za-z0-9_.:#-]{1,64}$/;
const MAX_JSON = 8192;

export class RunRecordError extends Error {}

export function assertStructured(v: unknown, path = 'output', depth = 0): void {
  if (depth > 6) throw new RunRecordError(`${path}: too deep`);
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RunRecordError(`${path}: not finite`);
    return;
  }
  if (typeof v === 'string') {
    if (!CODE.test(v))
      throw new RunRecordError(`${path}: free text is not storable`);
    return;
  }
  if (Array.isArray(v))
    return v.forEach((x, i) => assertStructured(x, `${path}[${i}]`, depth + 1));
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (!CODE.test(k)) throw new RunRecordError(`${path}: bad key`);
      assertStructured(x, `${path}.${k}`, depth + 1);
    }
    return;
  }
  throw new RunRecordError(`${path}: unsupported value`);
}

/** The one writer of moderation runs: start, store stage outputs, then complete, hold, fail or supersede. */
@Injectable()
export class RunRecorder {
  private readonly finishedHooks: ((runId: string) => Promise<unknown>)[] = [];

  constructor(private readonly store: RunStore) {}

  /** Called after a run completes, holds or fails (for example to purge its pseudonym tokens). A hook error never fails the run. */
  onFinished(hook: (runId: string) => Promise<unknown>): void {
    this.finishedHooks.push(hook);
  }

  private async finished<T>(runId: string, row: T | null): Promise<T | null> {
    if (row)
      for (const h of this.finishedHooks) await h(runId).catch(() => undefined);
    return row;
  }

  /** Returns the existing run for the key (with stored stages, for resume) or starts a new running one. */
  begin(i: BeginInput): Promise<BeginResult> {
    return this.store.begin(i);
  }

  saveStage(runId: string, s: StageInput): Promise<boolean> {
    assertStructured(s.output);
    if (JSON.stringify(s.output).length > MAX_JSON)
      throw new RunRecordError('output too large');
    return this.store.saveStage(runId, s);
  }

  /** Null when the run is no longer running (for example superseded): the caller must not apply it. */
  complete(
    runId: string,
    c: CompleteInput & { dpId: string },
  ): Promise<RunRow | null> {
    if (!OUTCOMES.includes(c.outcome as Outcome) || c.outcome === 'hold')
      throw new RunRecordError('complete needs a non-hold outcome; use hold()');
    assertEscalationAllowed(c.dpId, c.outcome as Outcome);
    return this.store.complete(runId, c).then((r) => this.finished(runId, r));
  }

  hold(runId: string, reason: HoldReason): Promise<RunRow | null> {
    if (!HOLD_REASONS.includes(reason))
      throw new RunRecordError(`unknown hold reason ${String(reason)}`);
    return this.store.hold(runId, reason).then((r) => this.finished(runId, r));
  }

  fail(runId: string) {
    return this.store.fail(runId).then((r) => this.finished(runId, r));
  }

  supersede(runId: string) {
    return this.store.supersede(runId);
  }
}
