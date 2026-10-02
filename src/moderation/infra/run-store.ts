import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { newId } from '../../domain/ids.js';
import { classMembers, type Trigger } from '../domain/run-key.js';

export interface BeginInput {
  targetKind: string;
  targetId: string;
  targetVersion: number;
  dpId: string;
  mode: 'blocking' | 'async';
  trigger: Trigger;
  policyVersion: string;
  packHash: string;
  eventId?: string | null;
}
export type RunRow = {
  id: string;
  status: 'running' | 'complete' | 'held' | 'failed' | 'superseded';
  outcome: string | null;
  held_reason: string | null;
  target_id: string;
  target_version: number;
};
export type StageRow = {
  stage: string;
  seq: number;
  output: Record<string, unknown>;
  model_id: string | null;
  prompt_hash: string | null;
};
export interface BeginResult {
  run: RunRow;
  /** Stored stage outputs, so the executor skips finished stages. Empty for a fresh run. */
  stages: StageRow[];
  created: boolean;
}
export interface StageInput {
  stage: string;
  seq?: number;
  output: Record<string, unknown>;
  modelId?: string | null;
  promptHash?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costMicroUsd?: number;
}
export interface CompleteInput {
  outcome: string;
  ruleIds?: string[];
  fieldRef?: string | null;
  revisionHint?: string | null;
  confidence?: number | null;
  publicExplanation?: string | null;
  latencyMs?: number;
  cache?: 'hit' | 'miss' | 'bypass';
  inputsHash?: Buffer | null;
}

const COLS = sql`id, status, outcome, held_reason, target_id, target_version`;

/** SQL for moderation_run and moderation_run_stage (09-u04). Rules live in RunRecorder. */
@Injectable()
export class RunStore {
  constructor(@Inject(DB) private readonly db: Db) {}

  async begin(i: BeginInput): Promise<BeginResult> {
    return this.db.transaction(async (tx) => {
      // One lock per target serialises begin: same-key races and supersede both need it.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${i.targetId}, 0))`,
      );
      const members = sql.join(
        classMembers(i.trigger).map((t) => sql`${t}`),
        sql`, `,
      );
      const found = await tx.execute<RunRow>(sql`
        select ${COLS} from moderation_run
        where target_id = ${i.targetId} and target_version = ${i.targetVersion}
          and dp_id = ${i.dpId} and policy_version = ${i.policyVersion}
          and shadow = false and trigger in (${members})
        order by created_at limit 1`);
      let run = found.rows[0];
      let created = false;
      if (run?.status === 'failed') {
        // A failed run is retried in place: its stored stages are kept.
        await tx.execute(
          sql`update moderation_run set status = 'running' where id = ${run.id}`,
        );
        run = { ...run, status: 'running' };
      } else if (!run) {
        const newer = await tx.execute(sql`
          select 1 from moderation_run
          where target_kind = ${i.targetKind} and target_id = ${i.targetId}
            and target_version > ${i.targetVersion} limit 1`);
        const id = newId();
        // A run for a version already overtaken is born superseded, never applied.
        const status = newer.rows.length ? 'superseded' : 'running';
        await tx.execute(sql`
          insert into moderation_run (id, event_id, target_kind, target_id, target_version,
            dp_id, mode, trigger, policy_version, pack_hash, status)
          values (${id}, ${i.eventId ?? null}, ${i.targetKind}, ${i.targetId}, ${i.targetVersion},
            ${i.dpId}, ${i.mode}, ${i.trigger}, ${i.policyVersion}, ${i.packHash}, ${status})`);
        run = {
          id,
          status,
          outcome: null,
          held_reason: null,
          target_id: i.targetId,
          target_version: i.targetVersion,
        };
        created = true;
      }
      if (run.status === 'running') {
        await tx.execute(sql`
          update moderation_run set status = 'superseded'
          where target_kind = ${i.targetKind} and target_id = ${i.targetId}
            and target_version < ${i.targetVersion} and status = 'running'`);
      }
      const stages = await tx.execute<StageRow>(sql`
        select stage, seq, output, model_id, prompt_hash from moderation_run_stage
        where run_id = ${run.id} order by created_at, seq`);
      return { run, stages: stages.rows, created };
    });
  }

  /** Stores one stage output; false if the run is no longer running. A repeat of (stage, seq) is a no-op. */
  async saveStage(runId: string, s: StageInput): Promise<boolean> {
    const r = await this.db.execute(sql`
      insert into moderation_run_stage (run_id, stage, seq, output, model_id, prompt_hash, tokens_in, tokens_out, cost_micro_usd)
      select id, ${s.stage}, ${s.seq ?? 0}, ${JSON.stringify(s.output)}::jsonb, ${s.modelId ?? null},
        ${s.promptHash ?? null}, ${s.tokensIn ?? 0}, ${s.tokensOut ?? 0}, ${s.costMicroUsd ?? 0}
      from moderation_run where id = ${runId} and status = 'running'
      on conflict do nothing`);
    return (r.rowCount ?? 0) > 0;
  }

  /** Finishes a running run, folding stage outputs, prompt hashes and cost into the run row. */
  complete(runId: string, c: CompleteInput): Promise<RunRow | null> {
    return this.finish(
      runId,
      sql`status = 'complete', outcome = ${c.outcome}, rule_ids = array(select jsonb_array_elements_text(${JSON.stringify(c.ruleIds ?? [])}::jsonb)),
        field_ref = ${c.fieldRef ?? null}, revision_hint = ${c.revisionHint ?? null},
        confidence = ${c.confidence ?? null}, public_explanation = ${c.publicExplanation ?? null},
        latency_ms = ${c.latencyMs ?? 0}, cache = ${c.cache ?? 'bypass'},
        inputs_hash = ${c.inputsHash ?? null}, ${this.rollup(runId)}`,
    );
  }

  hold(runId: string, reason: string): Promise<RunRow | null> {
    return this.finish(
      runId,
      sql`status = 'held', held_reason = ${reason}, outcome = 'hold', ${this.rollup(runId)}`,
    );
  }

  fail(runId: string): Promise<RunRow | null> {
    return this.finish(runId, sql`status = 'failed'`);
  }

  supersede(runId: string): Promise<RunRow | null> {
    return this.finish(runId, sql`status = 'superseded'`);
  }

  async get(runId: string): Promise<RunRow | null> {
    const r = await this.db.execute<RunRow>(
      sql`select ${COLS} from moderation_run where id = ${runId}`,
    );
    return r.rows[0] ?? null;
  }

  private rollup(runId: string) {
    return sql`
      outputs = coalesce((select jsonb_object_agg(stage, output) from (
        select distinct on (stage) stage, output from moderation_run_stage
        where run_id = ${runId} order by stage, seq desc) o), '{}'::jsonb),
      stage_prompt_hashes = coalesce((select jsonb_object_agg(stage, prompt_hash) from (
        select distinct on (stage) stage, prompt_hash from moderation_run_stage
        where run_id = ${runId} and prompt_hash is not null order by stage, seq desc) h), '{}'::jsonb),
      tokens_in = (select coalesce(sum(tokens_in), 0) from moderation_run_stage where run_id = ${runId}),
      tokens_out = (select coalesce(sum(tokens_out), 0) from moderation_run_stage where run_id = ${runId}),
      cost_micro_usd = (select coalesce(sum(cost_micro_usd), 0) from moderation_run_stage where run_id = ${runId})`;
  }

  /** Only a running run can finish; null means it was already superseded, held, failed or complete. */
  private async finish(
    runId: string,
    set: ReturnType<typeof sql>,
  ): Promise<RunRow | null> {
    const r = await this.db.execute<RunRow>(
      sql`update moderation_run set ${set} where id = ${runId} and status = 'running' returning ${COLS}`,
    );
    return r.rows[0] ?? null;
  }
}
