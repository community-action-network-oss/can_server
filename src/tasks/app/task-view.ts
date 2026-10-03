import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/db.module.js';
import { account, task, taskBlocker } from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';

/** Public view of a stage's tasks in creation order. Handles only, never ids of people. */
export async function loadTasks(db: Db | Tx, where: ReturnType<typeof eq>) {
  const rows = await db
    .select({ t: task, handle: account.handle })
    .from(task)
    .leftJoin(account, eq(account.id, task.ownerId))
    .where(where)
    .orderBy(asc(task.createdAt), asc(task.id));
  const ids = rows.map((r) => r.t.id);
  const bl = ids.length
    ? await db
        .select()
        .from(taskBlocker)
        .where(inArray(taskBlocker.taskId, ids))
        .orderBy(asc(taskBlocker.createdAt), asc(taskBlocker.id))
    : [];
  return rows.map(({ t, handle }) => ({
    id: t.id,
    stageId: t.stageId,
    title: t.title,
    content: t.description,
    status: t.status,
    required: t.required,
    assigneeHandle: handle,
    droppedReason: t.droppedReason,
    verified: t.verifiedBy !== null,
    verificationNote: t.verificationNote,
    blockers: bl
      .filter((b) => b.taskId === t.id)
      .map((b) => ({
        id: b.id,
        text: b.text,
        cleared: b.clearedAt !== null,
        clearedNote: b.clearedNote,
        createdAt: b.createdAt.toISOString(),
      })),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }));
}
