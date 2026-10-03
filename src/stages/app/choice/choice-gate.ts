import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { type GateRecordInput } from '../../../decisions/app/decision-records.service.js';
import {
  decideGate,
  type GateFinding,
  type GateLayer,
} from '../../../decisions/domain/legal-gate.js';
import { DB, type Db } from '../../../db/db.module.js';
import { problem, stage, stageOption } from '../../../db/schema.js';
import { newId } from '../../../domain/ids.js';
import { CLOCK, type Clock } from '../../../platform/ports.js';
import {
  LegalRegistry,
  tryRetrieveLegal,
} from '../../../policy/legal/index.js';
import type { LegalRetrieval } from '../../../policy/legal/index.js';
import { PolicyStore } from '../../../policy/app/policy-store.js';
import type { ChoiceGatePort } from '../ports.js';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** One finding per layer from what retrieval cites. ponytail: a retrieved article without a topic ban reads as `permits`; a model judge (FakeModel offline) can refine it later. */
export function findingsFrom(r: LegalRetrieval): GateFinding[] {
  return r.layers.map((l): GateFinding => {
    const base = {
      layer: l.layer as GateLayer,
      corpus_version: l.corpus_version,
    };
    if (l.notApplicable)
      return {
        ...base,
        finding: 'not_applicable',
        article_ids: [],
        blocks: false,
      };
    const banned = l.articles.filter((a) => a.topic_ban);
    if (banned.length)
      return {
        ...base,
        finding: 'constrains',
        article_ids: banned.map((a) => a.article_id),
        blocks: true,
      };
    if (l.articles.length)
      return {
        ...base,
        finding: 'permits',
        article_ids: l.articles.map((a) => a.article_id),
        blocks: false,
      };
    return { ...base, finding: 'none_found', article_ids: [], blocks: false };
  });
}

/**
 * CHOICE-GATE (DP-DECISION-RECORD and DP-LEGALITY, deterministic). Completeness of the decision record, then the layered legal
 * check. It never judges whether the choice is good. The client's own `legal_gate_record` is ignored here.
 */
@Injectable()
export class LegalChoiceGate implements ChoiceGatePort {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LegalRegistry) private readonly legal: LegalRegistry,
    @Inject(PolicyStore) private readonly store: PolicyStore,
  ) {}

  async check(i: Parameters<ChoiceGatePort['check']>[0]) {
    const out = (
      result: 'passed' | 'blocked' | 'needs_review' | 'held',
      extra: { gate?: GateRecordInput; hint?: Record<string, string> } = {},
    ) => ({ result, layer: 'both' as const, ...extra });
    const c = i.content;
    const missing: Record<string, string> = {};
    for (const k of ['rationale', 'authority', 'decision_method'])
      if (!str(c[k]).trim()) missing[`/${k}`] = 'required';
    if (Object.keys(missing).length)
      return out('needs_review', { hint: missing });

    const [r] = await this.db
      .select({ s: stage, p: problem })
      .from(stage)
      .innerJoin(problem, eq(problem.id, stage.problemId))
      .where(eq(stage.id, i.stageId));
    if (!r) return out('held');
    const j = r.p.jurisdictionId ?? 'default';
    let pack;
    try {
      pack = this.store.active(j);
    } catch {
      return out('held');
    }
    const ids = Array.isArray(c.chosen_option_ids)
      ? (c.chosen_option_ids as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        )
      : [];
    const opts = ids.length
      ? await this.db
          .select({ content: stageOption.content })
          .from(stageOption)
          .where(
            and(
              eq(stageOption.stageId, i.stageId),
              inArray(stageOption.id, ids),
            ),
          )
      : [];
    const steps = Array.isArray(c.steps)
      ? (c.steps as { step?: string }[])
      : [];
    const now = this.clock.now();
    const got = await tryRetrieveLegal(this.legal, {
      jurisdiction: j,
      at: now,
      dp: 'DP-LEGALITY',
      packLimits: pack.limits,
      typedFields: {
        topic: [r.p.title, r.p.condition, r.s.goal].filter(Boolean).join(' '),
        place: r.p.coarseArea ?? undefined,
        responsible_roles: opts.map((o) => str(o.content.responsible_role)),
        mechanism: [
          ...opts.map((o) => str(o.content.mechanism)),
          ...steps.map((s) => str(s.step)),
        ].join(' '),
        authority: str(c.authority),
      },
    });
    // Fail closed: no stack, a missing layer or an incomplete retrieval is a hold, never "no law applies".
    if (!got.ok || got.retrieval.escalate) return out('held');
    const v = decideGate(findingsFrom(got.retrieval));
    if (v.outcome === 'hold') return out('held');
    return out(v.outcome === 'clear' ? 'passed' : 'blocked', {
      gate: {
        outcome: v.outcome,
        findings: v.findings,
        constraintText: v.constraintText,
        sourceRef: v.sourceRef,
        packVersion: pack.version,
        checkedBy: `choice-gate:${newId()}`,
        checkedAt: now,
        // ponytail: constant until a ratifying panel exists (OQ-founder-stewardship-sunset), as elsewhere.
        transitional: true,
      },
    });
  }
}
