/** The six AI outcomes (decision-points.md "Shared contract"). Pure: no Nest, no I/O. */
export const OUTCOMES = [
  'publish',
  'needs_revision',
  'reject',
  'route_external',
  'hold',
  'escalate_human',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Every decision point id (DP-STAGE is not one: it was split into DP-STAGE-PLAN and DP-STAGE-RESOLUTION). */
export const DP_IDS = [
  'DP-APPEAL',
  'DP-ARCHIVE',
  'DP-ASSUMPTIONS',
  'DP-BLOCKER',
  'DP-CLOSURE',
  'DP-COMPLETENESS',
  'DP-CONTRIB-RELEVANCE',
  'DP-CRISIS',
  'DP-CRITERIA',
  'DP-DECISION-RECORD',
  'DP-DUPLICATE',
  'DP-ELIGIBILITY',
  'DP-EVIDENCE-TIER',
  'DP-FRAMING',
  'DP-LEGAL',
  'DP-LEGALITY',
  'DP-NAMING',
  'DP-PRIVACY',
  'DP-PUBLISH',
  'DP-RERESOLUTION',
  'DP-REUSE-FIT',
  'DP-SOURCE-TRUST',
  'DP-STAGE-DRAFT',
  'DP-STAGE-PLAN',
  'DP-STAGE-RESOLUTION',
  'DP-TONE',
  'DP-VERIFICATION',
] as const;
export type DpId = (typeof DP_IDS)[number];

/** Only these two decision points may emit escalate_human. */
export const ESCALATING_DPS: readonly DpId[] = ['DP-CRISIS', 'DP-LEGAL'];

export function assertEscalationAllowed(dpId: string, outcome: Outcome): void {
  if (outcome === 'escalate_human' && !ESCALATING_DPS.includes(dpId as DpId)) {
    throw new Error(`escalate_human is not allowed for ${dpId}`);
  }
}

/** Outcomes that end the current attempt for a target; hold leaves the item where it was. */
export const isTerminalForState = (o: Outcome): boolean => o !== 'hold';
