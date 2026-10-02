import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import { jurisdiction, problem, problemEvent } from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import { AuditPort } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import { checkLimits, type LimitField } from '../domain/eligibility/limits.js';

export const EDITABLE = ['draft', 'needs_revision', 'in_review'];
const FIELDS = [
  'title',
  'condition',
  'affected',
  'coarseArea',
  'desiredOutcome',
  'observed',
  'uncertain',
  'jurisdictionId',
] as const;
export type DraftInput = Partial<Record<(typeof FIELDS)[number], string>>;

const notFound = () => new ApiException(404, 'not_found', 'Problem not found');

@Injectable()
export class DraftsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AuditPort) private readonly audit: AuditPort,
  ) {}

  /** Never put content in events: only the names of changed fields. */
  private event(
    tx: Tx,
    problemId: string,
    type: string,
    actorId: string,
    from: string | null,
    to: string | null,
    payload: Record<string, unknown>,
  ) {
    return tx.insert(problemEvent).values({
      id: this.ids.next(),
      problemId,
      type,
      actorId,
      fromState: from,
      toState: to,
      payload,
      prevHash: null,
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
      occurredAt: this.clock.now(),
    });
  }

  private async validate(tx: Tx, input: DraftInput) {
    const errs: Record<string, string> = {};
    for (const v of checkLimits(input as Partial<Record<LimitField, string>>)
      .violations)
      errs[v.field] = `Use at most ${v.max} characters.`;
    if (input.jurisdictionId) {
      const [j] = await tx
        .select({ id: jurisdiction.id })
        .from(jurisdiction)
        .where(eq(jurisdiction.id, input.jurisdictionId));
      if (!j) errs.jurisdictionId = 'Unknown jurisdiction.';
    }
    if (Object.keys(errs).length)
      throw new ApiException(
        400,
        'validation_failed',
        'Some fields are too long or invalid.',
        errs,
      );
  }

  /** T00: no row exists to run through the engine, so the row and its event are written here in one transaction. */
  async create(accountId: string, input: DraftInput) {
    const id = this.ids.next();
    const now = this.clock.now();
    await withTransaction(this.db, async (tx) => {
      await this.validate(tx, input);
      await tx.insert(problem).values({
        id,
        initiatorId: accountId,
        state: 'draft',
        ...input,
        jurisdictionId: input.jurisdictionId ?? null,
        helpNeeded: {
          skill_groups: [],
          languages: [],
          coarse_place: null,
          topics: [],
        },
        originNodeId: config.nodeId,
        protocolVersion: PROTOCOL_VERSION,
        createdAt: now,
        updatedAt: now,
      });
      await this.event(tx, id, 'draft_created', accountId, null, 'draft', {
        transitionId: 'T00',
      });
    });
    return { id, state: 'draft', version: 1, updatedAt: now.toISOString() };
  }

  private async lock(tx: Tx, id: string, accountId: string) {
    const [r] = await tx
      .select()
      .from(problem)
      .where(eq(problem.id, id))
      .for('update');
    if (!r || r.initiatorId !== accountId || r.deletedAt) throw notFound();
    return r;
  }

  async update(
    accountId: string,
    id: string,
    input: DraftInput,
    expectedVersion: number,
  ) {
    const now = this.clock.now();
    return withTransaction(this.db, async (tx) => {
      const r = await this.lock(tx, id, accountId);
      if (!EDITABLE.includes(r.state))
        throw new ApiException(
          409,
          'invalid_transition',
          'This problem can no longer be edited.',
        );
      if (r.version !== expectedVersion)
        throw new ApiException(
          409,
          'conflict',
          'The problem changed; reload and retry.',
        );
      await this.validate(tx, input);
      const version = r.version + 1;
      await tx
        .update(problem)
        .set({ ...input, version, updatedAt: now })
        .where(eq(problem.id, id));
      await this.event(tx, id, 'draft_edited', accountId, r.state, r.state, {
        fields: Object.keys(input),
      });
      return { id, state: r.state, version, updatedAt: now.toISOString() };
    });
  }

  /**
   * T19. problem_event is insert-only and T00 always wrote an event, so the row cannot be hard-deleted.
   * The draft is scrubbed (all content nulled), stamped deleted_at and made invisible; a retention job removes the row later.
   */
  async remove(accountId: string, id: string): Promise<void> {
    const now = this.clock.now();
    await withTransaction(this.db, async (tx) => {
      const r = await this.lock(tx, id, accountId);
      if (r.state !== 'draft')
        throw new ApiException(
          409,
          'invalid_transition',
          'Only a draft can be discarded.',
        );
      await tx
        .update(problem)
        .set({
          title: null,
          condition: null,
          affected: null,
          coarseArea: null,
          desiredOutcome: null,
          observed: null,
          uncertain: null,
          intakeEvidence: null,
          noEvidenceNote: null,
          noSourceNote: null,
          jurisdictionId: null,
          deletedAt: now,
          purgedAt: now,
          version: r.version + 1,
          updatedAt: now,
        })
        .where(eq(problem.id, id));
      await this.event(tx, id, 'draft_deleted', accountId, 'draft', null, {
        transitionId: 'T19',
      });
      await this.audit.record(tx, {
        actorId: accountId,
        action: 'problem.draft_deleted',
        subjectType: 'problem',
        subjectId: id,
      });
    });
  }

  async mine(
    accountId: string,
    limit: number,
    cursor?: { at: Date; id: string },
  ) {
    const conds = [
      eq(problem.initiatorId, accountId),
      isNull(problem.deletedAt),
    ];
    if (cursor)
      conds.push(
        or(
          lt(problem.updatedAt, cursor.at),
          and(eq(problem.updatedAt, cursor.at), lt(problem.id, cursor.id)),
        )!,
      );
    return this.db
      .select()
      .from(problem)
      .where(and(...conds))
      .orderBy(desc(problem.updatedAt), desc(problem.id))
      .limit(limit + 1);
  }
}
