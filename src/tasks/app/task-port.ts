import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { task } from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';
import type { TaskPort } from '../../stages/app/ports.js';
import { UNFINISHED } from '../domain/task-rules.js';

/** ST04 prerequisite: every required task is done, or dropped with a reason (the CHECK keeps the reason). Runs in the engine's tx. */
@Injectable()
export class DbTaskPort implements TaskPort {
  openRequired(tx: Tx, stageId: string) {
    return tx
      .select({ id: task.id, status: task.status })
      .from(task)
      .where(
        and(
          eq(task.stageId, stageId),
          eq(task.required, true),
          inArray(task.status, [...UNFINISHED]),
        ),
      )
      .orderBy(asc(task.createdAt), asc(task.id));
  }
}
