/** Run triggers (runtime.md "Run record"); mirrors the moderation_run_trigger_chk list. */
export const TRIGGERS = [
  'submit_gate',
  'publish',
  'update',
  'plan_change',
  'stage_evidence',
  'review',
  'policy_change',
  'context_change',
  'sample',
  'appeal',
  'replay',
  'advisory',
  're_resolution',
  'archive',
  'reuse',
] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** Blocking triggers share one class (a re-delivery under another blocking trigger is the same run). */
const BLOCKING: readonly Trigger[] = [
  'submit_gate',
  'publish',
  'update',
  'plan_change',
  'stage_evidence',
  'review',
];

/** 'blocking', or the trigger itself (appeal and replay are their own classes, as is every async trigger). */
export const triggerClass = (t: Trigger): string =>
  BLOCKING.includes(t) ? 'blocking' : t;

/** Every trigger in the same class as t. */
export const classMembers = (t: Trigger): Trigger[] => {
  const c = triggerClass(t);
  return TRIGGERS.filter((x) => triggerClass(x) === c);
};

export interface RunKeyInput {
  targetId: string;
  targetVersion: number;
  dpId: string;
  policyVersion: string;
  trigger: Trigger;
}

/** Canonical run key (runtime.md "Idempotency"). Pure and stable. */
export const runKey = (i: RunKeyInput): string =>
  [
    i.targetId,
    i.targetVersion,
    i.dpId,
    i.policyVersion,
    triggerClass(i.trigger),
  ].join('|');
