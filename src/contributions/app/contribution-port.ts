import { Inject, Injectable } from '@nestjs/common';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import { contribution } from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import { PolicyStore } from '../../policy/app/policy-store.js';
import type { ContributionPort } from '../../stages/app/ports.js';
import { activeReplyCap, enforceReplyCap } from './reply-cap.js';

/**
 * Adapter for the stages ContributionPort: a stage option is also a reply, so it counts against the D-85 cap.
 * Stays pending_review until the moderation run accepts it. Bound to CONTRIBUTION_PORT in StagesModule; runs in the stage's own tx when given one.
 */
@Injectable()
export class DbContributionPort implements ContributionPort {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(PolicyStore) private readonly store: PolicyStore,
  ) {}

  async create(i: Parameters<ContributionPort['create']>[0], outer?: Tx) {
    const now = this.clock.now();
    const id = this.ids.next();
    const run = <T>(fn: (tx: Tx) => Promise<T>) =>
      outer ? fn(outer) : withTransaction(this.db, fn);
    await run(async (tx) => {
      await enforceReplyCap(
        tx,
        { accountId: i.authorId, problemId: i.problemId },
        now,
        activeReplyCap(this.store),
      );
      await tx.insert(contribution).values({
        id,
        problemId: i.problemId,
        stageId: i.stageId,
        authorId: i.authorId,
        type: i.type,
        body: i.content,
        status: 'pending_review',
        createdAt: now,
        originNodeId: config.nodeId,
        protocolVersion: PROTOCOL_VERSION,
      });
    });
    return { contributionId: id, status: 'pending' as const };
  }
}
