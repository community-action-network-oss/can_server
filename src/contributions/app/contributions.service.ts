import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  notInArray,
  or,
} from 'drizzle-orm';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import {
  account,
  contribution,
  evidenceRef,
  problem,
  problemEvent,
  stage,
  stageOption,
} from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import type { State } from '../../domain/lifecycle/vocabulary.js';
import { ApiException } from '../../platform/errors.js';
import { AuditPort } from '../../platform/audit/audit.service.js';
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
import { StructuredContentService } from '../../policy/app/structured-content.service.js';
import { PolicyStore } from '../../policy/app/policy-store.js';
import { pin } from '../../problems/app/schema-stamp.js';
import { visibleToViewer } from '../../stages/infra/stage-plan.repo.js';
import type { StageState } from '../../stages/domain/types.js';
import { isAllowed, isForLaterStage } from '../domain/allowed.js';
import { COOLDOWN, nextAllowedAt } from '../domain/cooldown.js';
import type { ContributionType } from '../domain/types.js';
import {
  ATTESTATION_PORT,
  type ContributionAttestationPort,
} from './attestation.port.js';
import { checkBody } from './contribution-checks.js';
import { activeReplyCap, enforceReplyCap } from './reply-cap.js';

const UUID = /^[0-9a-f-]{36}$/i;
const nf = () => new ApiException(404, 'not_found', 'Not found.');
const uid = (id: string) => {
  if (!UUID.test(id)) throw nf();
  return id;
};
const bad = (path: string, msg: string) =>
  new ApiException(400, 'validation_failed', 'Some answers need attention.', {
    [path]: msg,
  });
const HOUR = 3_600_000;
const SUBMITS_PER_HOUR = 30;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export interface CreateInput {
  type: string;
  stageId?: string;
  body: Record<string, unknown>;
  schemaVersion?: string;
  schemaHash?: string;
  answersContributionId?: string;
  attestation?: Record<string, unknown>;
  keptFlagIds?: string[];
}
type Row = typeof contribution.$inferSelect;

@Injectable()
export class ContributionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(StructuredContentService)
    private readonly structured: StructuredContentService,
    @Inject(PolicyStore) private readonly store: PolicyStore,
    @Inject(AuditPort) private readonly audit: AuditPort,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ATTESTATION_PORT)
    private readonly attest: ContributionAttestationPort,
  ) {}

  async list(
    problemId: string,
    viewerId: string | null,
    q: { stageId?: string; problemLevel?: string },
  ) {
    const [p] = await this.db
      .select()
      .from(problem)
      .where(eq(problem.id, uid(problemId)));
    if (!p || !visibleToViewer(p, viewerId)) throw nf();
    const own = viewerId ? eq(contribution.authorId, viewerId) : undefined;
    const rows = await this.db
      .select({ c: contribution, handle: account.handle })
      .from(contribution)
      .leftJoin(account, eq(account.id, contribution.authorId))
      .where(
        and(
          eq(contribution.problemId, p.id),
          or(
            eq(contribution.status, 'accepted'),
            // A tombstone stays as a dated placeholder only if it was ever published.
            and(
              eq(contribution.status, 'tombstoned'),
              isNotNull(contribution.reviewedAt),
            ),
            own ? and(own) : undefined,
          ),
          q.stageId ? eq(contribution.stageId, uid(q.stageId)) : undefined,
          q.problemLevel === 'true' ? isNull(contribution.stageId) : undefined,
        ),
      )
      .orderBy(asc(contribution.createdAt), asc(contribution.id));
    return {
      items: await this.wire(this.db, rows),
      criteria: { order: 'created_at_asc', usesEngagementSignals: false },
    };
  }

  async create(accountId: string, problemId: string, i: CreateInput) {
    if (
      !(await this.limiter.hit(`contrib:${accountId}`, SUBMITS_PER_HOUR, HOUR))
    )
      throw new ApiException(
        429,
        'rate_limited',
        'Too many requests. Try again later.',
      );
    const type = i.type as ContributionType;
    const [p] = await this.db
      .select()
      .from(problem)
      .where(eq(problem.id, uid(problemId)));
    if (!p || !visibleToViewer(p, accountId)) throw nf();
    let st: typeof stage.$inferSelect | undefined;
    if (i.stageId) {
      [st] = await this.db
        .select()
        .from(stage)
        .where(eq(stage.id, uid(i.stageId)));
      if (!st || st.problemId !== p.id)
        throw bad('stageId', 'This stage is not part of the problem.');
    }
    if (
      !isAllowed({
        problemState: p.state as State,
        stageState: (st?.state as StageState) ?? null,
        type,
      })
    )
      throw new ApiException(
        409,
        'not_allowed_in_state',
        'This kind of reply is not open here right now.',
      );

    const made = await withTransaction(this.db, async (tx) => {
      const now = this.clock.now();
      const stamp = await this.structured.stamp(
        tx,
        `contribution.${type}`,
        now,
        {
          version: i.schemaVersion,
          hash: i.schemaHash,
        },
      );
      await this.structured.validate(tx, `contribution.${type}`, stamp, i.body);
      const refs = checkBody(i.body, i.keptFlagIds);
      if (type === 'evidence' && !refs.length)
        throw bad('/body/evidence_refs', 'Add at least one link.');
      await this.checkAnswers(tx, p.id, type, i.answersContributionId);
      if (i.attestation) await this.attest.attest(accountId, i.attestation); // ponytail: result has no column until 14-u02

      // The advisory lock inside enforceReplyCap serialises this account's submits on this problem; read the cooldown after it.
      let cap: ApiException | null = null;
      try {
        await enforceReplyCap(
          tx,
          { accountId, problemId: p.id },
          now,
          activeReplyCap(this.store),
        );
      } catch (e) {
        if (!(e instanceof ApiException) || e.code !== 'reply_limit_reached')
          throw e;
        cap = e;
      }
      const wait = await this.cooldownUntil(tx, accountId, p.id, type, now);
      // The stricter wins: the one that frees up later.
      const capAt = cap ? new Date(String(cap.extra?.resetsAt)) : null;
      if (wait && (!capAt || wait.getTime() >= capAt.getTime()))
        throw new ApiException(
          429,
          'cooldown_active',
          'Take a moment before your next reply. You can send it shortly.',
          undefined,
          {
            retryAfterSeconds: Math.ceil(
              (wait.getTime() - now.getTime()) / 1000,
            ),
          },
        );
      if (cap) throw cap;

      const id = this.ids.next();
      const later = isForLaterStage((st?.state as StageState) ?? null);
      await tx.insert(contribution).values({
        id,
        problemId: p.id,
        stageId: st?.id ?? null,
        forLaterStage: later,
        authorId: accountId,
        type,
        body: i.body,
        ...pin(stamp),
        status: 'pending_review',
        answersContributionId: i.answersContributionId ?? null,
        createdAt: now,
        originNodeId: config.nodeId,
        protocolVersion: PROTOCOL_VERSION,
      });
      if (refs.length)
        await tx.insert(evidenceRef).values(
          refs.map((r) => ({
            id: this.ids.next(),
            contributionId: id,
            url: r.url,
            note: r.note,
            kind: r.category,
            addedAt: now,
          })),
        );
      if (type === 'proposed_solution' && st)
        // Stays hidden (pending) until the contribution is accepted.
        await tx.insert(stageOption).values({
          id: this.ids.next(),
          stageId: st.id,
          contributionId: id,
          authorId: accountId,
          mechanism: String(i.body.mechanism ?? ''),
          risks: Array.isArray(i.body.risks) ? i.body.risks.join('\n') : '',
          content: i.body,
          ...pin(stamp),
          status: 'pending',
          forLaterStage: later,
          createdAt: now,
        });
      await this.event(tx, p.id, 'contribution.submitted', accountId, now, {
        contributionId: id,
        ...(st && { stageId: st.id }),
        type,
      });
      await this.audit.record(tx, {
        actorId: accountId,
        action: 'contribution.create',
        subjectType: 'contribution',
        subjectId: id,
        detail: { problemId: p.id, type },
      });
      return id;
    });
    return this.one(made);
  }

  async update(
    accountId: string,
    id: string,
    i: {
      withdraw?: boolean;
      body?: Record<string, unknown>;
      keptFlagIds?: string[];
    },
  ) {
    if (!i.withdraw === !i.body)
      throw bad('body', 'Send either withdraw or new answers.');
    await withTransaction(this.db, async (tx) => {
      const now = this.clock.now();
      const [c] = await tx
        .select()
        .from(contribution)
        .where(eq(contribution.id, uid(id)))
        .for('update');
      if (!c || c.authorId !== accountId) throw nf();
      if (i.withdraw) {
        if (c.status === 'tombstoned') return;
        await tx
          .update(contribution)
          .set({ status: 'tombstoned', body: {}, tombstonedAt: now })
          .where(eq(contribution.id, c.id));
        await tx
          .delete(evidenceRef)
          .where(eq(evidenceRef.contributionId, c.id));
        await tx
          .update(stageOption)
          .set({ status: 'withdrawn' })
          .where(eq(stageOption.contributionId, c.id));
        await this.event(
          tx,
          c.problemId,
          'contribution.withdrawn',
          accountId,
          now,
          { contributionId: c.id },
        );
        await this.audit.record(tx, {
          actorId: accountId,
          action: 'contribution.withdraw',
          subjectType: 'contribution',
          subjectId: c.id,
          detail: { problemId: c.problemId },
        });
        return;
      }
      // A published item changes only through an on-update run; withdraw and resubmit instead.
      if (c.status !== 'pending_review')
        throw new ApiException(
          409,
          'conflict',
          'This reply can no longer be edited. Withdraw it and send a new one.',
        );
      const stamp = {
        schemaId: c.schemaId!,
        schemaVersion: c.schemaVersion!,
        schemaHash: c.schemaHash!,
      };
      await this.structured.validate(
        tx,
        `contribution.${c.type}`,
        stamp,
        i.body!,
      );
      const refs = checkBody(i.body!, i.keptFlagIds);
      if (c.type === 'evidence' && !refs.length)
        throw bad('/body/evidence_refs', 'Add at least one link.');
      await tx
        .update(contribution)
        .set({ body: i.body! })
        .where(eq(contribution.id, c.id));
      await tx.delete(evidenceRef).where(eq(evidenceRef.contributionId, c.id));
      if (refs.length)
        await tx.insert(evidenceRef).values(
          refs.map((r) => ({
            id: this.ids.next(),
            contributionId: c.id,
            url: r.url,
            note: r.note,
            kind: r.category,
            addedAt: now,
          })),
        );
      await tx
        .update(stageOption)
        .set({
          mechanism: String(i.body!.mechanism ?? ''),
          risks: Array.isArray(i.body!.risks) ? i.body!.risks.join('\n') : '',
          content: i.body!,
        })
        .where(eq(stageOption.contributionId, c.id));
      // Edits are not replies (D-85); the event tells the moderation run to start over.
      await this.event(tx, c.problemId, 'contribution.edited', accountId, now, {
        contributionId: c.id,
      });
    });
    return this.one(id);
  }

  // ---- helpers ----

  private async one(id: string) {
    const rows = await this.db
      .select({ c: contribution, handle: account.handle })
      .from(contribution)
      .leftJoin(account, eq(account.id, contribution.authorId))
      .where(eq(contribution.id, id));
    return (await this.wire(this.db, rows))[0]!;
  }

  private async wire(q: Db | Tx, rows: { c: Row; handle: string | null }[]) {
    const refs = rows.length
      ? await q
          .select()
          .from(evidenceRef)
          .where(
            inArray(
              evidenceRef.contributionId,
              rows.map((r) => r.c.id),
            ),
          )
          .orderBy(asc(evidenceRef.addedAt), asc(evidenceRef.id))
      : [];
    return rows.map(({ c, handle }) => ({
      id: c.id,
      type: c.type,
      stageId: c.stageId,
      forLaterStage: c.forLaterStage,
      body: c.status === 'tombstoned' ? null : c.body,
      authorHandle: handle ?? c.systemActor ?? '',
      createdAt: c.createdAt.toISOString(),
      status: c.status,
      answersContributionId: c.answersContributionId,
      tombstonedAt: iso(c.tombstonedAt),
      evidenceRefs: refs
        .filter((r) => r.contributionId === c.id)
        .map((r) => ({ url: r.url, note: r.note, category: r.kind })),
    }));
  }

  /** factual_claim may answer a published clarifying_question of the same problem. */
  private async checkAnswers(
    tx: Tx,
    problemId: string,
    type: ContributionType,
    answers?: string,
  ) {
    if (!answers) return;
    if (type !== 'factual_claim')
      throw bad(
        'answersContributionId',
        'Only a factual claim can answer a question.',
      );
    const [q] = await tx
      .select()
      .from(contribution)
      .where(eq(contribution.id, uid(answers)));
    if (
      !q ||
      q.problemId !== problemId ||
      q.type !== 'clarifying_question' ||
      q.status !== 'accepted'
    )
      throw bad(
        'answersContributionId',
        'Choose a published question on this problem.',
      );
  }

  private async cooldownUntil(
    tx: Tx,
    accountId: string,
    problemId: string,
    type: ContributionType,
    now: Date,
  ) {
    const mine = and(
      eq(contribution.authorId, accountId),
      eq(contribution.problemId, problemId),
    );
    const [r] = await tx
      .select({ last: max(contribution.createdAt) })
      .from(contribution)
      .where(
        and(mine, notInArray(contribution.type, [...COOLDOWN.exemptTypes])),
      );
    const [h] = await tx
      .select({ at: max(contribution.reviewedAt) })
      .from(contribution)
      .where(and(mine, eq(contribution.status, 'hidden')));
    return nextAllowedAt({
      now,
      type,
      lastContributionAt: r?.last ?? null,
      lastRejectedAt: h?.at ?? null,
    });
  }

  private event(
    tx: Tx,
    problemId: string,
    type: string,
    actorId: string,
    now: Date,
    payload: Record<string, unknown>,
  ) {
    // Ids only. The relay ignores types it has no mapping for until the moderation run unit maps them.
    return tx.insert(problemEvent).values({
      id: this.ids.next(),
      problemId,
      type,
      actorId,
      fromState: null,
      toState: null,
      payload,
      prevHash: null,
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
      occurredAt: now,
    });
  }
}
