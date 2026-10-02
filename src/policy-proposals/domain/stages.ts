export const STAGES = [
  'submitted',
  'eval',
  'replay',
  'ratification',
  'shadow',
  'canary',
  'full',
  'rejected',
  'withdrawn',
] as const;
export type Stage = (typeof STAGES)[number];

/** Pure transition table. Backward edges exist only for blocked reports; terminal stages have none. */
export const TRANSITIONS: Record<Stage, readonly Stage[]> = {
  submitted: ['eval', 'rejected', 'withdrawn'],
  eval: ['replay', 'rejected', 'withdrawn'],
  replay: ['eval', 'ratification', 'rejected', 'withdrawn'],
  ratification: ['eval', 'replay', 'shadow', 'rejected', 'withdrawn'],
  shadow: ['canary', 'rejected'],
  canary: ['full', 'shadow', 'rejected'],
  full: [],
  rejected: [],
  withdrawn: [],
};

export const isStage = (s: unknown): s is Stage =>
  typeof s === 'string' && (STAGES as readonly string[]).includes(s);

export const canTransition = (from: Stage, to: Stage): boolean =>
  TRANSITIONS[from].includes(to);

export type ReportKind = 'eval' | 'replay';
/** Stages in which a report of each kind is accepted. */
export const REPORT_STAGES: Record<ReportKind, readonly Stage[]> = {
  eval: ['submitted', 'eval', 'replay', 'ratification'],
  replay: ['replay', 'ratification'],
};

/** Where a blocked report puts the proposal: the stage named after the report, unless it is already there. */
export const blockedTarget = (kind: ReportKind, from: Stage): Stage | null =>
  from === kind ? null : kind;

/** Panel status key for the view; the panel itself is OQ-ratification-method. */
export function panelStatus(
  s: Stage,
): 'not_started' | 'waiting_for_panel' | 'ratified' | 'closed' {
  if (s === 'rejected' || s === 'withdrawn') return 'closed';
  if (s === 'ratification') return 'waiting_for_panel';
  if (s === 'shadow' || s === 'canary' || s === 'full') return 'ratified';
  return 'not_started';
}
