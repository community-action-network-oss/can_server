import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { stage } from '../../db/schema.js';
import type { ActiveStages } from '../../domain/lifecycle/vocabulary.js';
import type { StageChipPort } from '../../problems/app/stage-chip.port.js';

/** The real StageChipPort. Bind it in ProblemsModule (STAGE_CHIP useClass) when that module can import StagesModule. */
@Injectable()
export class DbStageChips implements StageChipPort {
  constructor(@Inject(DB) private readonly db: Db) {}
  async chips(problemIds: string[]) {
    const out = new Map<string, ActiveStages>();
    if (!problemIds.length) return out;
    const rows = await this.db
      .select({
        p: stage.problemId,
        name: stage.label,
        slug: stage.name,
        state: stage.state,
      })
      .from(stage)
      .where(inArray(stage.problemId, problemIds));
    for (const id of problemIds) {
      const on = rows.filter(
        (r) => r.p === id && (r.state === 'active' || r.state === 'resolving'),
      );
      if (on.length)
        out.set(
          id,
          on.length === 1
            ? { kind: 'one', name: on[0].name ?? on[0].slug }
            : { kind: 'many', n: on.length },
        );
    }
    return out;
  }
}
