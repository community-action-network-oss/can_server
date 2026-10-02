// Lifecycle v2 problem transition table, T00 to T22 (D-72). Single executable form of
// docs/spec/01a-lifecycle.md section 4.2. guard.spec.ts parses that file and fails on drift.
// Stage transitions (ST01 to ST11) belong to 12-u01. Pure data; no I/O.
import type { State } from './vocabulary.js';

export type ActorKind = 'initiator' | 'run' | 'lane' | 'system';
export type DpId = string;
export type FieldKey = string;
export type ConditionName =
  | 'noOtherAcceptedContribution'
  | 'feasibilityPassed'
  | 'everyRequiredStageResolvedOrSkipped'
  | 'noRemainingRequiredStageCanProceed'
  | 'atLeastOneCompletedReview'
  | 'reviewQuorumMetOrPosterOverride';

export type TransitionId = `T${string}`;

export interface Transition {
  id: TransitionId;
  from: readonly (State | 'none')[];
  to: State | 'resume_state' | 'deleted' | 'same';
  /** Who may apply it. "run" is a recorded moderation run (needs a run id). */
  actors: readonly ActorKind[];
  /** Who may only propose it; a run then decides. */
  proposedBy: readonly ActorKind[];
  gatedBy: readonly DpId[];
  required: readonly FieldKey[];
  sideEffects: readonly string[];
  conditions: readonly ConditionName[];
}

const t = (
  x: Omit<
    Transition,
    'proposedBy' | 'gatedBy' | 'required' | 'sideEffects' | 'conditions'
  > &
    Partial<Transition>,
): Transition => ({
  proposedBy: [],
  gatedBy: [],
  required: [],
  sideEffects: [],
  conditions: [],
  ...x,
});

const DECISION = ['ruleIds'] as const;

export const TRANSITIONS: readonly Transition[] = [
  // T00 (none) -> draft | poster | required: none
  t({
    id: 'T00',
    from: ['none'],
    to: 'draft',
    actors: ['initiator'],
    sideEffects: ['autosave', 'offerClassic5'],
  }),
  // T01 draft -> in_review | poster | form complete against current schema; sync checks and DP-PRIVACY pass
  t({
    id: 'T01',
    from: ['draft'],
    to: 'in_review',
    actors: ['initiator'],
    gatedBy: ['DP-PRIVACY'],
    required: [
      'title',
      'structuralStatement',
      'facts',
      'affectedScope',
      'coarseArea',
      'sources',
      'finalAcceptanceCriteria',
      'stagePlan',
      'noIdentifiersConfirmed',
      'schemaVersionPin',
    ],
    sideEffects: [
      'syncChecks',
      'maskPersonalData',
      'versionSnapshot',
      'event',
      'storeFingerprint',
      'enterReviewQueue',
    ],
  }),
  // T02 in_review -> needs_revision | moderation run (DP-PUBLISH needs_revision) | decision: rule_ids, field refs, hints, appealable_until
  t({
    id: 'T02',
    from: ['in_review'],
    to: 'needs_revision',
    actors: ['run'],
    gatedBy: [
      'DP-PUBLISH',
      'DP-COMPLETENESS',
      'DP-ASSUMPTIONS',
      'DP-FRAMING',
      'DP-PRIVACY',
      'DP-NAMING',
      'DP-TONE',
      'DP-SOURCE-TRUST',
      'DP-CRITERIA',
      'DP-STAGE-PLAN',
    ],
    required: [...DECISION, 'fieldRefs', 'revisionHints', 'appealableUntil'],
    sideEffects: ['emailPoster', 'keepDraft', 'showHints'],
  }),
  // T03 needs_revision -> in_review | poster | at least one flagged field changed
  t({
    id: 'T03',
    from: ['needs_revision'],
    to: 'in_review',
    actors: ['initiator'],
    required: ['changedFlaggedField'],
    sideEffects: [
      'versionSnapshot',
      'rerunChecks',
      'markHintsAddressed',
      'reopenRecommendations',
    ],
  }),
  // T04 in_review -> active | moderation run (DP-PUBLISH publish) | publication request, completed review (REVIEW-1), quorum (OQ-review-quorum)
  // Open recommendations are weighed by the run, never counted as accepted (RECO-1), so no condition here.
  t({
    id: 'T04',
    from: ['in_review'],
    to: 'active',
    actors: ['run'],
    gatedBy: [
      'DP-PUBLISH',
      'DP-ELIGIBILITY',
      'DP-COMPLETENESS',
      'DP-ASSUMPTIONS',
      'DP-PRIVACY',
      'DP-FRAMING',
      'DP-DUPLICATE',
      'DP-NAMING',
      'DP-TONE',
      'DP-EVIDENCE-TIER',
      'DP-SOURCE-TRUST',
      'DP-CRITERIA',
      'DP-STAGE-PLAN',
      'DP-LEGALITY',
      'DP-CRISIS',
    ],
    required: [...DECISION, 'publicationRequest'],
    conditions: [
      'atLeastOneCompletedReview',
      'reviewQuorumMetOrPosterOverride',
    ],
    sideEffects: [
      'jurisdiction',
      'computeInvestigationNeeded',
      'publish',
      'showHandle',
      'provisionalSteward',
      'instantiateStages',
      'draftStagePlan',
      'reviewContentStaysPrivate',
      'email',
      'purgeFingerprint',
    ],
  }),
  // T05 in_review -> rejected | moderation run (DP-PUBLISH reject; DP-CRISIS; DP-LEGALITY) | rule_ids, public explanation, appealable_until
  t({
    id: 'T05',
    from: ['in_review'],
    to: 'rejected',
    actors: ['run'],
    gatedBy: ['DP-PUBLISH', 'DP-CRISIS', 'DP-LEGALITY'],
    required: [...DECISION, 'publicExplanation', 'appealableUntil'],
    sideEffects: [
      'email',
      'deletionDate30d',
      'fingerprint90d',
      'endVolunteerAccess',
    ],
  }),
  // T06 in_review or held -> withdrawn | poster | none
  t({
    id: 'T06',
    from: ['in_review', 'held'],
    to: 'withdrawn',
    actors: ['initiator'],
    sideEffects: ['deletionDate30d', 'fingerprint90d', 'endVolunteerAccess'],
  }),
  // T07 needs_revision -> withdrawn | poster, or system after 30 days without activity | none
  // ponytail: the 30-day inactivity check is the caller's; the guard only allows actor system.
  t({
    id: 'T07',
    from: ['needs_revision'],
    to: 'withdrawn',
    actors: ['initiator', 'system'],
    sideEffects: ['deletionDate30d', 'fingerprint90d', 'endVolunteerAccess'],
  }),
  // T08 draft -> held | system (T01 gate run could not complete) | failed run id
  t({
    id: 'T08',
    from: ['draft'],
    to: 'held',
    actors: ['system'],
    required: ['failedRunId'],
    sideEffects: ['storeResumeState', 'queueRetry'],
  }),
  // T09 in_review -> held | system (DP-PUBLISH or aggregated DP failed, PUB-FAILCLOSED-1) | failed run id
  t({
    id: 'T09',
    from: ['in_review'],
    to: 'held',
    actors: ['system'],
    required: ['failedRunId'],
    sideEffects: ['storeResumeState', 'queueRetry'],
  }),
  // T10 held -> resume state (draft or in_review) | system | run completed
  t({
    id: 'T10',
    from: ['held'],
    to: 'resume_state',
    actors: ['system'],
    required: ['completedRunId'],
    sideEffects: ['applyRunOutcome'],
  }),
  // T11 active -> paused | poster or moderation run | reason code, resume condition, review date
  t({
    id: 'T11',
    from: ['active'],
    to: 'paused',
    actors: ['initiator', 'run'],
    required: ['reasonCode', 'resumeCondition', 'reviewDate'],
    sideEffects: ['storeResumeState', 'refuseStageTransitions', 'event'],
  }),
  // T12 paused -> active | poster or moderation run | resume-condition-met note
  t({
    id: 'T12',
    from: ['paused'],
    to: 'active',
    actors: ['initiator', 'run'],
    required: ['resumeConditionNote'],
    sideEffects: ['event', 'stagesContinue'],
  }),
  // T13 active -> stuck | poster proposes, moderation run decides (DP-BLOCKER, DP-LEGALITY) | blocker statement, source+version, blocked actions, recheck, route, 1+ attempt
  t({
    id: 'T13',
    from: ['active'],
    to: 'stuck',
    actors: ['run'],
    proposedBy: ['initiator'],
    gatedBy: ['DP-BLOCKER', 'DP-LEGALITY'],
    required: [
      'blockerStatement',
      'blockerSource',
      'blockerSourceVersion',
      'blockedActions',
      'recheckCondition',
      'escalationRoute',
      'documentedAttempt',
    ],
    conditions: ['noRemainingRequiredStageCanProceed'],
    sideEffects: ['event', 'showBlocker', 'buildUnresolvedArchive'],
  }),
  // T14 stuck -> active | poster proposes, moderation run decides (DP-BLOCKER, DP-LEGALITY) | blocker-cleared note with evidence
  t({
    id: 'T14',
    from: ['stuck'],
    to: 'active',
    actors: ['run'],
    proposedBy: ['initiator'],
    gatedBy: ['DP-BLOCKER', 'DP-LEGALITY'],
    required: ['blockerClearedNote', 'evidenceIds'],
    sideEffects: ['event', 'restoreBlockedStages'],
  }),
  // T15 active -> solved | poster (or system) proposes, run decides (DP-VERIFICATION, DP-EVIDENCE-TIER) | criteria evidence, outcome statement
  t({
    id: 'T15',
    from: ['active'],
    to: 'solved',
    actors: ['run'],
    proposedBy: ['initiator', 'system'],
    gatedBy: ['DP-VERIFICATION', 'DP-EVIDENCE-TIER'],
    required: ['criteriaEvidence', 'outcomeStatement'],
    conditions: ['everyRequiredStageResolvedOrSkipped'],
    sideEffects: ['buildArchive', 'emailFollowers', 'showPolicyVersion'],
  }),
  // T16 active, paused or stuck -> closed | poster proposes, run decides (DP-DUPLICATE, DP-ELIGIBILITY, DP-CLOSURE) | reason code, explanation (+ duplicate_of if duplicate)
  // ponytail: duplicateOf is required only for reason duplicate; that content check is the closure DP's.
  t({
    id: 'T16',
    from: ['active', 'paused', 'stuck'],
    to: 'closed',
    actors: ['run'],
    proposedBy: ['initiator'],
    gatedBy: ['DP-DUPLICATE', 'DP-ELIGIBILITY', 'DP-CLOSURE'],
    required: ['reasonCode', 'explanation'],
    sideEffects: [
      'buildArchive',
      'skipUnresolvedStages',
      'showPolicyVersion',
      'emailFollowers',
    ],
  }),
  // T17 active, paused or stuck -> redirected | poster proposes, run decides (DP-ELIGIBILITY, DP-CRISIS, DP-CLOSURE) | destination, route text, reason
  t({
    id: 'T17',
    from: ['active', 'paused', 'stuck'],
    to: 'redirected',
    actors: ['run'],
    proposedBy: ['initiator'],
    gatedBy: ['DP-ELIGIBILITY', 'DP-CRISIS', 'DP-CLOSURE'],
    required: ['destination', 'routeText', 'reasonCode'],
    sideEffects: ['buildArchive', 'skipUnresolvedStages', 'showPolicyVersion'],
  }),
  // T18 active -> withdrawn | poster, only if no other account has an accepted contribution | none
  t({
    id: 'T18',
    from: ['active'],
    to: 'withdrawn',
    actors: ['initiator'],
    conditions: ['noOtherAcceptedContribution'],
    sideEffects: [
      'keepVisibleAsWithdrawn',
      'tombstonePosterText',
      'buildArchive',
      'skipUnresolvedStages',
    ],
  }),
  // T19 draft -> (deleted) | poster | none
  t({
    id: 'T19',
    from: ['draft'],
    to: 'deleted',
    actors: ['initiator'],
    sideEffects: ['removeDraft'],
  }),
  // T20 REOPEN-RULE solved, closed, redirected or stuck -> active | run (DP-RERESOLUTION reopen) | old/new policy version, changed conclusion, rule ids, affected stages, feasibility result
  t({
    id: 'T20',
    from: ['solved', 'closed', 'redirected', 'stuck'],
    to: 'active',
    actors: ['run'],
    gatedBy: ['DP-RERESOLUTION'],
    required: [
      'oldPolicyVersion',
      'newPolicyVersion',
      'changedConclusion',
      'changedRuleIds',
      'affectedStages',
      'feasibilityResult',
    ],
    conditions: ['feasibilityPassed'],
    sideEffects: [
      'event',
      'keepHistory',
      'keepOldArchive',
      'notice',
      'reopenAffectedStages',
      'appealable',
    ],
  }),
  // T21 REOPEN-EVIDENCE solved -> active | run (DP-RERESOLUTION reopen) | old/new policy version, changed evidence rule, why unmet, affected criteria, feasibility
  t({
    id: 'T21',
    from: ['solved'],
    to: 'active',
    actors: ['run'],
    gatedBy: ['DP-RERESOLUTION', 'DP-EVIDENCE-TIER', 'DP-VERIFICATION'],
    required: [
      'oldPolicyVersion',
      'newPolicyVersion',
      'changedEvidenceRule',
      'unmetEvidenceReason',
      'affectedCriteria',
      'feasibilityResult',
    ],
    conditions: ['feasibilityPassed'],
    sideEffects: [
      'event',
      'keepHistory',
      'keepOldArchive',
      'notice',
      'reopenEvidenceStages',
      'appealable',
    ],
  }),
  // T22 PLAN-CHANGE active (also paused) -> same state | poster proposes, run decides (DP-STAGE-PLAN, DP-CRITERIA) | plan proposal with reasons
  t({
    id: 'T22',
    from: ['active', 'paused'],
    to: 'same',
    actors: ['run'],
    proposedBy: ['initiator'],
    gatedBy: ['DP-STAGE-PLAN', 'DP-CRITERIA'],
    required: ['planProposal'],
    sideEffects: [
      'newPlanVersion',
      'event',
      'applyStageTransitions',
      'publicReason',
    ],
  }),
];

/** Section 4.3 of the spec. Runtime code must not use this (tests and one-time fixture migration only). */
export const oldToNewTransitionId: Readonly<Record<string, readonly string[]>> =
  {
    T00: ['T00'],
    T01: ['T01'],
    T02: ['T02'],
    T03: ['T03'],
    T04: ['T04'],
    T05: ['T05'],
    T06: ['T06'],
    T07: ['T07'],
    T08: ['T04', 'ST05'],
    T09: ['ST05'],
    T10: ['T22', 'ST10'],
    T11: ['ST05'],
    T12: ['ST05'],
    T13: ['ST06', 'T15', 'T22'],
    T14: ['T15', 'ST05'],
    T15: ['T13', 'ST07'],
    T16: ['T14', 'ST08'],
    T17: ['T11'],
    T18: ['T12'],
    T19: ['T16'],
    T20: ['T17'],
    T21: ['T18'],
    T22: ['T19'],
    T23: ['T20'],
    T24: ['T21'],
  };
