import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { config } from '../../config.js';
import {
  contribution,
  evidenceRef,
  problem,
  problemEvent,
  stageEvidence,
} from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import { markOptionPublic } from '../../stages/app/options/option-rules.js';
import {
  investigationNeeded,
  recomputeEvidenceTier,
  tierOfKind,
} from '../domain/evidence-tier.js';

export type TierSource = 'deterministic' | 'dp_evidence_tier';

/**
 * Called by the contribution adapter (09-u40) inside its publish transaction, after the run accepted an
 * evidence-bearing contribution. `override` is DP-EVIDENCE-TIER's tier (1-6) and is tied to a run id, never to text.
 */
export interface ContributionPublishedHook {
  onPublished(
    tx: Tx,
    i: { contributionId: string; override?: { tier: number; runId: string } },
  ): Promise<{ tier: number; changed: boolean } | null>;
}
export const CONTRIBUTION_PUBLISHED_HOOK = Symbol('ContributionPublishedHook');

@Injectable()
export class EvidenceTierService implements ContributionPublishedHook {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async onPublished(
    tx: Tx,
    i: { contributionId: string; override?: { tier: number; runId: string } },
  ) {
    const [c] = await tx
      .select()
      .from(contribution)
      .where(eq(contribution.id, i.contributionId));
    if (!c || c.status !== 'accepted') return null;
    await markOptionPublic(tx, c.id);
    if (c.type === 'verification_evidence') return null;
    const own = await tx
      .select()
      .from(evidenceRef)
      .where(eq(evidenceRef.contributionId, c.id));
    if (!own.length) return null;

    // Per-ref tier, then the same tier on the stage's own evidence rows for those URLs.
    for (const r of own)
      await tx
        .update(evidenceRef)
        .set({ tier: tierOfKind(r.kind) })
        .where(eq(evidenceRef.id, r.id));
    if (c.stageId)
      for (const r of own)
        await tx
          .update(stageEvidence)
          .set({ tier: String(tierOfKind(r.kind)) })
          .where(
            and(
              eq(stageEvidence.stageId, c.stageId),
              eq(stageEvidence.url, r.url),
            ),
          );

    const [p] = await tx
      .select()
      .from(problem)
      .where(eq(problem.id, c.problemId))
      .for('update');
    if (!p) return null;
    const o = i.override;
    if (o && !(Number.isInteger(o.tier) && o.tier >= 1 && o.tier <= 6))
      throw new Error('tier override must be 1-6');

    let tier: number;
    let source: TierSource;
    if (o) {
      tier = o.tier;
      source = 'dp_evidence_tier';
    } else if (p.evidenceTierSource === 'dp_evidence_tier' && p.evidenceTier) {
      return { tier: Number(p.evidenceTier), changed: false };
    } else {
      const kinds = await tx
        .select({ kind: evidenceRef.kind })
        .from(evidenceRef)
        .innerJoin(
          contribution,
          eq(contribution.id, evidenceRef.contributionId),
        )
        .where(
          and(
            eq(contribution.problemId, p.id),
            eq(contribution.status, 'accepted'),
            ne(contribution.type, 'verification_evidence'),
          ),
        );
      tier = recomputeEvidenceTier(kinds.map((k) => k.kind));
      source = 'deterministic';
    }
    const flag = investigationNeeded(tier);
    const changed = p.evidenceTier !== String(tier);
    if (
      changed ||
      p.investigationNeeded !== flag ||
      p.evidenceTierSource !== source
    )
      await tx
        .update(problem)
        .set({
          evidenceTier: String(tier),
          evidenceTierSource: source,
          investigationNeeded: flag,
        })
        .where(eq(problem.id, p.id));
    if (changed)
      await tx.insert(problemEvent).values({
        id: this.ids.next(),
        problemId: p.id,
        type: 'evidence_tier_changed',
        actorId: null,
        fromState: null,
        toState: null,
        // Ids and numbers only.
        payload: {
          from: p.evidenceTier ? Number(p.evidenceTier) : null,
          to: tier,
          source,
          contributionId: c.id,
          ...(o && { runId: o.runId }),
        },
        prevHash: null,
        originNodeId: config.nodeId,
        protocolVersion: PROTOCOL_VERSION,
        occurredAt: this.clock.now(),
      });
    return { tier, changed };
  }
}
