// Task status rules (05-u01). Pure: no Nest, no I/O.
export const TASK_STATUSES = [
  'open',
  'claimed',
  'in_progress',
  'done',
  'dropped',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A required task in one of these blocks ST04. */
export const UNFINISHED: readonly TaskStatus[] = [
  'open',
  'claimed',
  'in_progress',
];

/** What a PATCH may set. `claimed` comes only from the claim route, `open` never comes back. */
export const PATCHABLE: readonly TaskStatus[] = [
  'in_progress',
  'done',
  'dropped',
];

const NEXT: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ['dropped'],
  claimed: ['in_progress', 'done', 'dropped'],
  in_progress: ['done', 'dropped'],
  done: [],
  dropped: [],
};

export const canMove = (from: TaskStatus, to: TaskStatus) =>
  NEXT[from].includes(to);

export interface Who {
  accountId: string;
  isSteward: boolean;
  isPoster: boolean;
  assigneeId: string | null;
}

/** Status changes and blockers: the assignee, the poster (who made the tasks) or a steward. */
export const mayManage = (w: Who) =>
  w.isSteward || w.isPoster || (!!w.assigneeId && w.assigneeId === w.accountId);

/** VERIFY-1: whoever did the task cannot verify it. */
export const mayVerify = (w: Who) =>
  !w.assigneeId || w.assigneeId !== w.accountId;
