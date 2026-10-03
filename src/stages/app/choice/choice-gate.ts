import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import {
  FailClosedLegalJudge,
  LEGAL_JUDGE,
  type LegalJudgePort,
} from './legal-judge.js';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

type Finding = Omit<GateFinding, 'finding'> & {
  finding: GateFinding['finding'] | 'unjudged';
};

/** One finding per layer. A topic ban blocks; any other retrieved article goes to the judge (fail-closed default: `unjudged`). */
export async function findingsFrom(
  r: LegalRetrieval,
  judge: LegalJudgePort,
): Promise<Finding[]> {
  return Promise.all(
    r.layers.map(async (l): Promise<Finding> => {
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
      if (!l.articles.length)
        return {
          ...base,
          finding: 'none_found',
          article_ids: [],
          blocks: false,
        };
      const finding = await judge.judge(l);
      const banned = l.articles.filter((a) => a.topic_ban);
      const cited =
        finding === 'constrains' && banned.length ? banned : l.articles;
      return {
        ...base,
        finding,
        article_ids: cited.map((a) => a.article_id),
        blocks: finding === 'constrains',
      };
    }),
  );
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
    @Optional()
    @Inject(LEGAL_JUDGE)
    private readonly judge: LegalJudgePort = new FailClosedLegalJudge(),
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
    const found = await findingsFrom(got.retrieval, this.judge);
    // A block stands. Otherwise an unjudged layer holds: retrieved is not permitted (FAIL-CLOSED-AI-1).
    if (
      !found.some((f) => f.blocks) &&
      found.some((f) => f.finding === 'unjudged')
    ) {
      new Logger('ChoiceGate').warn('legal_judgement_pending');
      return out('held');
    }
    // Only a blocked record can carry `unjudged`; the stored findings stay honest.
    const v = decideGate(found as GateFinding[]);
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
