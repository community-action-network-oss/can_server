import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { checkBody } from '../../contributions/app/contribution-checks.js';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import {
  problem,
  stage,
  stageChoice,
  stageEvent,
  task,
  taskBlocker,
} from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import { ApiException } from '../../platform/errors.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import type { AuthContext } from '../../platform/security/decorators.js';
import { pin } from '../../problems/app/schema-stamp.js';
import {
  StructuredContentService,
  type SchemaStamp,
} from '../../policy/app/structured-content.service.js';
import { ContentSchemaNotFound } from '../../policy/domain/pack.js';
import { visibleToViewer } from '../../stages/infra/stage-plan.repo.js';
import {
  CONTRIBUTION_PORT,
  type ContributionPort,
} from '../../stages/app/ports.js';
import {
  canMove,
  mayManage,
  mayVerify,
  type TaskStatus,
} from '../domain/task-rules.js';
import type {
  AddBlockerBodyDto,
  ClearBlockerBodyDto,
  PatchTaskBodyDto,
  TaskContentBodyDto,
} from '../http/tasks.dto.js';
import { loadTasks } from './task-view.js';

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
type Viewer = Pick<AuthContext, 'accountId' | 'role'>;
type TaskRow = typeof task.$inferSelect;
type StageRow = typeof stage.$inferSelect;
type ProblemRow = typeof problem.$inferSelect;
type Body = Pick<
  TaskContentBodyDto,
  'content' | 'schemaVersion' | 'schemaHash'
>;

/**
 * Stage tasks (05-u01). Every write locks the stage row first (the same row StageEngine locks for ST04), so a
 * claim, a status change and the submit check cannot interleave. Claims and progress notes are progress_update
 * contributions made through ContributionPort in the same tx: they count toward the D-85 reply cap. Creating a
 * task is the poster's work, not a reply.
 */
@Injectable()
export class TasksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(StructuredContentService)
    private readonly structured: StructuredContentService,
    @Inject(CONTRIBUTION_PORT) private readonly contributions: ContributionPort,
  ) {}

  async list(stageId: string, viewerId: string | null) {
    const [r] = await this.db
      .select({ p: problem })
      .from(stage)
      .innerJoin(problem, eq(problem.id, stage.problemId))
      .where(eq(stage.id, uid(stageId)));
    if (!r || !visibleToViewer(r.p, viewerId)) throw nf();
    return { items: await loadTasks(this.db, eq(task.stageId, stageId)) };
  }

  async create(stageId: string, a: Viewer, b: Body) {
    return withTransaction(this.db, async (tx) => {
      const { s, p } = await this.lockStage(tx, stageId, a.accountId);
      if (!this.steward(a) && p.initiatorId !== a.accountId)
        throw new ApiException(403, 'not_permitted', 'You cannot do that.');
      this.requireOpen(p, s, ['active']);
      let choiceId: string | null = null;
      if (s.needsChoice) {
        const [c] = await tx
          .select()
          .from(stageChoice)
          .where(
            and(eq(stageChoice.stageId, s.id), isNull(stageChoice.withdrawnAt)),
          );
        // Fail closed: only a passed choice gate starts the stage's tasks (CHOICE-GATE).
        if (c?.gateResult?.result !== 'passed')
          throw new ApiException(
            409,
            'choice_required',
            'Record a choice that passed its check before adding tasks.',
          );
        choiceId = c.id;
      }
      const stamp = await this.validate(tx, 'task', b);
      const c = b.content as { stage_ref?: unknown; deliverable?: unknown };
      if (c.stage_ref !== s.name)
        throw bad('/content/stage_ref', 'Must name this stage.');
      const { stage_ref: _s, ...prose } = b.content;
      checkBody(prose);
      const now = this.clock.now();
      const [row] = await tx
        .insert(task)
        .values({
          id: this.ids.next(),
          problemId: p.id,
          stageId: s.id,
          stageChoiceId: choiceId,
          title: String(c.deliverable ?? '').slice(0, 300),
          description: b.content,
          ...pin(stamp),
          createdBy: a.accountId,
          createdAt: now,
          updatedAt: now,
          originNodeId: config.nodeId,
          protocolVersion: PROTOCOL_VERSION,
        })
        .returning();
      await this.event(tx, s, 'task_added', a.accountId, { taskId: row.id });
      return this.one(tx, row.id);
    });
  }

  /** Claim: a progress_update that names the task. One winner; a loser spends no reply. */
  async claim(taskId: string, a: Viewer, b: Body) {
    return withTransaction(this.db, async (tx) => {
      const { t, s, p } = await this.lockTask(tx, taskId, a.accountId);
      this.requireOpen(p, s, ['active', 'blocked']);
      if (t.status !== 'open')
        throw new ApiException(
          409,
          t.ownerId ? 'task_taken' : 'task_closed',
          t.ownerId
            ? 'Someone else is already doing this task.'
            : 'This task is closed.',
        );
      await this.reply(tx, t, s, p, a, b);
      await tx
        .update(task)
        .set({
          ownerId: a.accountId,
          status: 'claimed',
          updatedAt: this.clock.now(),
        })
        .where(eq(task.id, t.id));
      await this.event(tx, s, 'task_claimed', a.accountId, { taskId: t.id });
      return this.one(tx, t.id);
    });
  }

  /** A progress note from the assignee, again a progress_update. The first one moves claimed to in_progress. */
  async progress(taskId: string, a: Viewer, b: Body) {
    return withTransaction(this.db, async (tx) => {
      const { t, s, p } = await this.lockTask(tx, taskId, a.accountId);
      this.requireOpen(p, s, ['active', 'blocked']);
      if (t.ownerId !== a.accountId)
        throw new ApiException(403, 'not_permitted', 'You cannot do that.');
      if (t.status !== 'claimed' && t.status !== 'in_progress')
        throw new ApiException(409, 'task_closed', 'This task is closed.');
      await this.reply(tx, t, s, p, a, b);
      await tx
        .update(task)
        .set({ status: 'in_progress', updatedAt: this.clock.now() })
        .where(eq(task.id, t.id));
      await this.event(tx, s, 'task_progress', a.accountId, { taskId: t.id });
      return this.one(tx, t.id);
    });
  }

  async patch(taskId: string, a: Viewer, b: PatchTaskBodyDto) {
    return withTransaction(this.db, async (tx) => {
      const { t, s, p } = await this.lockTask(tx, taskId, a.accountId);
      const w = this.who(a, p, t);
      this.requireOpen(p, s, ['active', 'blocked']);
      if (b.verificationNote !== undefined) {
        if (b.status !== undefined || b.droppedReason !== undefined)
          throw bad('/verificationNote', 'Verify on its own.');
        if (t.status !== 'done')
          throw new ApiException(
            409,
            'task_not_done',
            'Only a done task is verified.',
          );
        if (!mayVerify(w))
          throw new ApiException(
            403,
            'cannot_verify_own',
            'Someone other than the doer must verify this task.',
          );
        checkBody({ verificationNote: b.verificationNote });
        await tx
          .update(task)
          .set({
            verifiedBy: a.accountId,
            verificationNote: b.verificationNote,
            updatedAt: this.clock.now(),
          })
          .where(eq(task.id, t.id));
        await this.event(tx, s, 'task_verified', a.accountId, { taskId: t.id });
        return this.one(tx, t.id);
      }
      if (b.status === undefined) throw bad('/status', 'Say what to change.');
      if (!mayManage(w))
        throw new ApiException(403, 'not_permitted', 'You cannot do that.');
      const to = b.status as TaskStatus;
      if (!canMove(t.status as TaskStatus, to))
        throw new ApiException(
          409,
          'invalid_transition',
          'This task cannot move there.',
        );
      const reason = b.droppedReason?.trim();
      if (to === 'dropped') {
        if (!reason)
          throw bad('/droppedReason', 'Say why this task is dropped.');
        checkBody({ droppedReason: reason });
      }
      await tx
        .update(task)
        .set({
          status: to,
          droppedReason: to === 'dropped' ? reason : null,
          updatedAt: this.clock.now(),
        })
        .where(eq(task.id, t.id));
      await this.event(
        tx,
        s,
        to === 'done' ? 'task_done' : `task_${to}`,
        a.accountId,
        { taskId: t.id },
      );
      return this.one(tx, t.id);
    });
  }

  async addBlocker(taskId: string, a: Viewer, b: AddBlockerBodyDto) {
    return withTransaction(this.db, async (tx) => {
      const { t, s, p } = await this.lockTask(tx, taskId, a.accountId);
      this.requireOpen(p, s, ['active', 'blocked']);
      if (!mayManage(this.who(a, p, t)))
        throw new ApiException(403, 'not_permitted', 'You cannot do that.');
      if (t.status === 'done' || t.status === 'dropped')
        throw new ApiException(409, 'task_closed', 'This task is closed.');
      checkBody({ text: b.text });
      await tx.insert(taskBlocker).values({
        id: this.ids.next(),
        taskId: t.id,
        text: b.text,
        createdBy: a.accountId,
        createdAt: this.clock.now(),
      });
      await this.event(tx, s, 'task_blocker_added', a.accountId, {
        taskId: t.id,
      });
      return this.one(tx, t.id);
    });
  }

  async clearBlocker(
    taskId: string,
    blockerId: string,
    a: Viewer,
    b: ClearBlockerBodyDto,
  ) {
    return withTransaction(this.db, async (tx) => {
      const { t, s, p } = await this.lockTask(tx, taskId, a.accountId);
      this.requireOpen(p, s, ['active', 'blocked']);
      if (!mayManage(this.who(a, p, t)))
        throw new ApiException(403, 'not_permitted', 'You cannot do that.');
      const [bl] = await tx
        .select()
        .from(taskBlocker)
        .where(
          and(eq(taskBlocker.id, uid(blockerId)), eq(taskBlocker.taskId, t.id)),
        );
      if (!bl) throw nf();
      if (bl.clearedAt)
        throw new ApiException(409, 'conflict', 'Already cleared.');
      if (b.note) checkBody({ note: b.note });
      await tx
        .update(taskBlocker)
        .set({ clearedAt: this.clock.now(), clearedNote: b.note ?? null })
        .where(eq(taskBlocker.id, bl.id));
      await this.event(tx, s, 'task_blocker_cleared', a.accountId, {
        taskId: t.id,
      });
      return this.one(tx, t.id);
    });
  }

  // ---- helpers ----

  private steward = (a: Viewer) => a.role === 'moderator' || a.role === 'admin';

  private who(a: Viewer, p: ProblemRow, t: TaskRow) {
    return {
      accountId: a.accountId,
      isSteward: this.steward(a),
      isPoster: p.initiatorId === a.accountId,
      assigneeId: t.ownerId,
    };
  }

  /** The problem must be running and the stage in one of `states`. */
  private requireOpen(p: ProblemRow, s: StageRow, states: string[]) {
    if (p.state !== 'active')
      throw new ApiException(
        409,
        'problem_not_open',
        'This problem is not active.',
      );
    if (s.state === 'planned' || s.state === 'ready')
      throw new ApiException(409, 'not_ready', 'This stage has not started.');
    if (!states.includes(s.state))
      throw new ApiException(
        409,
        'stage_closed',
        'This stage is not taking task changes now.',
      );
  }

  /** The progress_update behind a claim or a note. It names this task and counts as a reply (D-85). */
  private async reply(
    tx: Tx,
    t: TaskRow,
    s: StageRow,
    p: ProblemRow,
    a: Viewer,
    b: Body,
  ) {
    await this.validate(tx, 'contribution.progress_update', b);
    if (b.content.task_ref !== t.id)
      throw bad('/content/task_ref', 'Must be the id of this task.');
    checkBody(b.content);
    await this.contributions.create(
      {
        problemId: p.id,
        stageId: s.id,
        authorId: a.accountId,
        type: 'progress_update',
        content: b.content,
      },
      tx,
    );
  }

  private async lockStage(tx: Tx, stageId: string, viewerId: string) {
    const [r] = await tx
      .select({ s: stage, p: problem })
      .from(stage)
      .innerJoin(problem, eq(problem.id, stage.problemId))
      .where(eq(stage.id, uid(stageId)))
      .for('update', { of: stage });
    if (!r || !visibleToViewer(r.p, viewerId)) throw nf();
    return r;
  }

  private async lockTask(tx: Tx, taskId: string, viewerId: string) {
    const [t0] = await tx
      .select({ stageId: task.stageId })
      .from(task)
      .where(eq(task.id, uid(taskId)));
    if (!t0) throw nf();
    const { s, p } = await this.lockStage(tx, t0.stageId, viewerId);
    const [t] = await tx.select().from(task).where(eq(task.id, taskId));
    return { t: t!, s, p };
  }

  private async one(tx: Tx, id: string) {
    return (await loadTasks(tx, eq(task.id, id)))[0]!;
  }

  /** Pinned schema when the active pack has one; a pack without it skips validation (as the stage routes do). */
  private async validate(
    tx: Tx,
    type: string,
    b: Body,
  ): Promise<SchemaStamp | null> {
    let stamp: SchemaStamp;
    try {
      stamp = await this.structured.stamp(tx, type, this.clock.now(), {
        version: b.schemaVersion,
        hash: b.schemaHash,
      });
    } catch (e) {
      if (e instanceof ContentSchemaNotFound) return null;
      throw e;
    }
    await this.structured.validate(tx, type, stamp, b.content, 'submit');
    return stamp;
  }

  private event(
    tx: Tx,
    s: StageRow,
    type: string,
    actorId: string,
    payload: Record<string, unknown>,
  ) {
    return tx.insert(stageEvent).values({
      id: this.ids.next(),
      stageId: s.id,
      problemId: s.problemId,
      type,
      actorId,
      payload,
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
      occurredAt: this.clock.now(),
    });
  }
}
