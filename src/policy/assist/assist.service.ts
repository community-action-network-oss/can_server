import { createHash } from 'node:crypto';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  AI_GATEWAY,
  type AiGatewayPort,
} from '../../ai-gateway/domain/types.js';
import { PrivacyGateway } from '../../ai-gateway/app/redaction/privacy-gateway.js';
import { TokenStore } from '../../ai-gateway/infra/token-store.js';
import { DB, type Db } from '../../db/db.module.js';
import { problem } from '../../db/schema.js';
import { AuditPort } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors.js';
import { log } from '../../platform/logging/logger.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import {
  RATE_LIMITER,
  type RateLimiter,
} from '../../platform/security/rate-limiter.js';
import { EDITABLE } from '../../problems/app/drafts.service.js';
import { PACK_SOURCE, type PackSource } from '../app/pack-source.js';
import { PolicyStore } from '../app/policy-store.js';
import { SchemaVersionRepo } from '../infra/schema-version.repo.js';
import {
  shapeAssist,
  type AssistQuestion,
  type AssistSuggestion,
} from './assist-guards.js';
import { loadAssistSection } from './assist-section.js';

export interface AssistResult {
  suggestions: AssistSuggestion[];
  questions: AssistQuestion[];
  assist_run_id: string;
  policy_version: string;
  prompt_hash: string;
  model_id: string;
}

const TYPE = 'problem';
const NOTES_MAX = 4000;
const PER_DAY = 30;
const DAY = 86_400_000;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const num = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? v : d);

/** The form keeps working without AI: every failure of the gateway or model ends here. */
export const assistUnavailable = () =>
  new HttpException(
    {
      error: {
        code: 'assist_unavailable',
        message:
          'Suggestions are not available right now. You can keep filling in the form yourself.',
      },
    },
    503,
  );

@Injectable()
export class AssistService {
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AI_GATEWAY) private readonly gateway: AiGatewayPort,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(PACK_SOURCE) private readonly source: PackSource,
    private readonly store: PolicyStore,
    private readonly versions: SchemaVersionRepo,
    private readonly privacy: PrivacyGateway,
    private readonly tokens: TokenStore,
    private readonly audit: AuditPort,
  ) {}

  /** Proposals only: nothing is written to the draft, the notes and suggestions are never stored (hashes only). */
  async run(
    accountId: string,
    problemId: string,
    body: { notes: string; fields?: string[] },
  ): Promise<AssistResult> {
    const [draft] = await this.db
      .select()
      .from(problem)
      .where(
        and(eq(problem.id, problemId), eq(problem.initiatorId, accountId)),
      );
    if (!draft || draft.deletedAt || !EDITABLE.includes(draft.state))
      throw new ApiException(404, 'not_found', 'Problem not found');

    let pack;
    try {
      pack = this.store.active('default');
    } catch {
      throw assistUnavailable();
    }
    const lim = (pack.limits.assist ?? {}) as Record<string, unknown>;
    const max = num(lim.notes_max_chars, NOTES_MAX);
    const notes = body.notes;
    if (!notes.trim() || [...notes].length > max)
      throw new ApiException(400, 'validation_failed', 'Check the notes.', {
        notes: `Write between 1 and ${max} characters.`,
      });
    if (
      !(await this.limiter.hit(
        `assist:${accountId}`,
        num(lim.per_day, PER_DAY),
        DAY,
      ))
    )
      throw new ApiException(
        429,
        'rate_limited',
        'Too many suggestion requests today. Try again tomorrow.',
      );

    const runId = this.ids.next();
    const fail = async (why: string): Promise<never> => {
      await this.audit
        .record(this.db, {
          actorId: accountId,
          action: 'ai.assist.run',
          subjectType: 'problem',
          subjectId: problemId,
          detail: { assistRunId: runId, outcome: 'unavailable', reason: why },
        })
        .catch(() => undefined);
      throw assistUnavailable();
    };

    try {
      // The draft's own pinned form decides the fields; fall back to the active one.
      const row = draft.schemaHash
        ? await this.versions.byHash(this.db, TYPE, draft.schemaHash)
        : undefined;
      const forPack =
        (row && this.store.findByVersion(row.packVersion)) || pack;
      const schema = forPack.schemas[TYPE]?.schema as
        { properties?: Record<string, Record<string, unknown>> } | undefined;
      const allowed = Object.entries(schema?.properties ?? {})
        .filter(
          ([k, p]) =>
            FIELD.test(k) &&
            p.type === 'string' &&
            (p['x-checks'] as Record<string, unknown> | undefined)
              ?.no_assist !== true,
        )
        .map(([k]) => k)
        .filter((k) => !body.fields || body.fields.includes(k));
      if (!allowed.length) return await fail('no_fields');

      const sec = await loadAssistSection(pack, this.source);
      const prepared = await this.privacy.prepare({
        runId,
        dpId: null,
        stage: 'assist-fill',
        providerId: 'assist',
        fields: [{ zone: 'transient_raw', fieldRef: 'notes', text: notes }],
      });

      const validate = this.validator(sec.schema);
      let out: StageOut | undefined;
      for (let attempt = 0; attempt < 2 && !out; attempt++) {
        const r = await this.gateway.run({
          kind: 'assist',
          stage: 'assist-fill',
          dpId: null,
          template: sec.template,
          ruleSlice: sec.ruleSlice,
          fields: prepared.fields,
          serverLines: [{ label: 'fields', value: allowed.join(', ') }],
          schema: sec.schema,
          metadata: { jurisdiction: 'default', policyVersion: pack.version },
        });
        const ok =
          validate(r.json) &&
          (r.json as { rule_ids: string[] }).rule_ids.every((id) =>
            sec.ruleIds.includes(id),
          );
        if (ok) out = { ...r, json: r.json as Raw };
      }
      if (!out) return await fail('invalid_output');

      const spans = prepared.spans.notes ?? [];
      const shaped =
        out.json.outcome === 'hold'
          ? { suggestions: [], questions: [], dropped: 0 }
          : shapeAssist(out.json, {
              allowed: new Set(allowed),
              notes,
              tokens: spans.map((s) => s.token),
              originals: spans.map((s) => notes.slice(s.start, s.end)),
              floor: sec.publishFloor,
            });
      // Tokens are never resolved back into text: the gate refuses token-shaped output, so no original reaches the response.
      await this.audit.record(this.db, {
        actorId: accountId,
        action: 'ai.assist.run',
        subjectType: 'problem',
        subjectId: problemId,
        detail: {
          assistRunId: runId,
          policyVersion: pack.version,
          promptHash: out.promptHash,
          modelId: out.modelId,
          inputsHash: sha(JSON.stringify([notes, allowed])),
          outcome: 'ok',
          offered: shaped.suggestions.length,
          asked: shaped.questions.length,
          dropped: shaped.dropped,
          usage: { in: out.tokensIn, out: out.tokensOut },
        },
      });
      return {
        suggestions: shaped.suggestions,
        questions: shaped.questions,
        assist_run_id: runId,
        policy_version: pack.version,
        prompt_hash: out.promptHash,
        model_id: out.modelId,
      };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      // Codes only: never the message, which could carry text.
      log('warn', 'assist failed', {
        runId,
        kind: (e as { code?: string }).code ?? 'error',
      });
      return await fail('gateway');
    } finally {
      await this.tokens.purgeOperation(runId).catch(() => undefined);
    }
  }

  private validator(schema: Record<string, unknown>) {
    const key = sha(JSON.stringify(schema));
    let v = this.validators.get(key);
    if (!v) {
      v = new Ajv2020({ strict: true }).compile(schema);
      this.validators.set(key, v);
    }
    return v;
  }
}

interface Raw {
  outcome: string;
  confidence: number;
  suggestions?: {
    field_ref: { field: string };
    value: string;
    basis: string;
  }[];
  questions?: { field_ref: { field: string }; text: string }[];
}
interface StageOut {
  json: Raw;
  promptHash: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
}
