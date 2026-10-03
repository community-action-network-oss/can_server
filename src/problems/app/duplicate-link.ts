import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/db.module.js';
import { problem, problemEvent } from '../../db/schema.js';
import {
  isPublicState,
  type State,
} from '../../domain/lifecycle/vocabulary.js';
import { ApiException } from '../../platform/errors.js';
import { UuidV7Generator } from '../../platform/ports.js';
import { config } from '../../config.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';

export const DUPLICATE_REASONS = [
  'same_problem',
  'same_cause',
  'already_handled_there',
  'other',
] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

const MAX_DEPTH = 10;
// Moves that end a problem own the duplicate_of field themselves (T16), so a loose link or unlink is refused there.
const LOCKED = ['closed', 'solved', 'redirected', 'withdrawn'];
const ids = new UuidV7Generator();

/** Publicly linkable: published, not tombstoned or deleted, and in a public state. */
export const linkable = (t: typeof problem.$inferSelect) =>
  !!t.publishedAt &&
  !t.tombstonedAt &&
  !t.deletedAt &&
  t.state !== 'withdrawn' &&
  isPublicState(t.state as State, t.withdrawnPublished);

const bad = (code: number, key: string, msg: string) =>
  new ApiException(code, key, msg);

/**
 * Set or clear duplicate_of on the initiator's own problem. Never merges, hides or deletes anything:
 * it writes the link and an ids-only problem_event (reason is a fixed code, never free text).
 */
export async function setDuplicateLink(
  db: Db,
  a: {
    problemId: string;
    accountId: string;
    targetId: string | null;
    reason?: DuplicateReason;
  },
): Promise<string | null> {
  return db.transaction(async (tx) => {
    // One global lock: two links racing (A to B, B to A) cannot both pass the cycle walk.
    // ponytail: serialises all duplicate writes; fine at link volume, shard by chain root if it ever matters.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('duplicate_link'))`,
    );
    const [src] = await tx
      .select()
      .from(problem)
      .where(and(eq(problem.id, a.problemId), isNull(problem.deletedAt)))
      .for('update');
    if (!src || src.initiatorId !== a.accountId || src.tombstonedAt)
      throw bad(404, 'not_found', 'Problem not found');
    if (LOCKED.includes(src.state))
      throw bad(
        409,
        'invalid_transition',
        'This problem is already closed out.',
      );
    if (a.targetId) {
      if (a.targetId === src.id)
        throw bad(
          400,
          'validation_failed',
          'A problem cannot duplicate itself.',
        );
      const [t] = await tx
        .select()
        .from(problem)
        .where(eq(problem.id, a.targetId));
      // Same answer for missing and non-public targets, so a private problem's existence never leaks.
      if (!t || !linkable(t))
        throw bad(404, 'not_found', 'That problem is not available to link.');
      let cur: string | null = t.id;
      for (let d = 0; cur; d++) {
        if (cur === src.id || d >= MAX_DEPTH)
          throw bad(
            409,
            'conflict',
            'That link would make a loop or a chain that is too long.',
          );
        const [n] = await tx
          .select({ to: problem.duplicateOf })
          .from(problem)
          .where(eq(problem.id, cur));
        cur = n?.to ?? null;
      }
    } else if (!src.duplicateOf) {
      throw bad(404, 'not_found', 'No duplicate link to remove.');
    }
    const now = new Date();
    await tx
      .update(problem)
      .set({ duplicateOf: a.targetId, updatedAt: now })
      .where(eq(problem.id, src.id));
    await tx.insert(problemEvent).values({
      id: ids.next(),
      problemId: src.id,
      type: a.targetId ? 'duplicate_linked' : 'duplicate_unlinked',
      actorId: a.accountId,
      fromState: src.state,
      toState: src.state,
      reason: a.targetId ? (a.reason ?? 'other') : null,
      payload: { duplicateOfId: a.targetId ?? src.duplicateOf },
      prevHash: null,
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
      occurredAt: now,
    });
    return a.targetId;
  });
}
