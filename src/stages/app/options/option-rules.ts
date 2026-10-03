import { and, eq, isNull } from 'drizzle-orm';
import { stageChoice, stageOption } from '../../../db/schema.js';
import type { Db } from '../../../db/db.module.js';
import type { Tx } from '../../../db/tx.js';

/** Options are read only once a choice stands for the stage (04-u04 step 4). */
export async function hasLiveChoice(tx: Tx | Db, stageId: string) {
  const [r] = await tx
    .select({ id: stageChoice.id })
    .from(stageChoice)
    .where(
      and(eq(stageChoice.stageId, stageId), isNull(stageChoice.withdrawnAt)),
    )
    .limit(1);
  return !!r;
}

/**
 * Called inside the publish transaction when moderation accepted the contribution behind an option.
 * It flips the existing row only: no contribution is created and the D-85 cap is not touched again.
 */
export async function markOptionPublic(tx: Tx, contributionId: string) {
  await tx
    .update(stageOption)
    .set({ status: 'public' })
    .where(
      and(
        eq(stageOption.contributionId, contributionId),
        eq(stageOption.status, 'pending'),
      ),
    );
}
