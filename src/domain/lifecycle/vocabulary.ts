// Lifecycle v2 problem-state vocabulary. Copy mirrors docs/spec/01a-lifecycle.md (section 4.2).
// The transition table is not here (03-u01); stage chips belong to the stages domain (12-u01).

export const STATES = [
  'draft',
  'in_review',
  'needs_revision',
  'held',
  'rejected',
  'active',
  'paused',
  'stuck',
  'redirected',
  'closed',
  'withdrawn',
  'solved',
] as const;
export type State = (typeof STATES)[number];

export type StateClass = 'pre_publication' | 'working' | 'resting' | 'terminal';

export const STATE_CLASS: Record<State, StateClass> = {
  draft: 'pre_publication',
  in_review: 'pre_publication',
  needs_revision: 'pre_publication',
  held: 'pre_publication',
  rejected: 'pre_publication',
  active: 'working',
  paused: 'resting',
  stuck: 'resting',
  solved: 'terminal',
  closed: 'terminal',
  redirected: 'terminal',
  withdrawn: 'terminal',
};

/** Public routes may show a state. `publishedBefore` matters only for withdrawn (T18, OWN-1); the caller decides it. */
export function isPublicState(state: State, publishedBefore = false): boolean {
  if (state === 'withdrawn') return publishedBefore;
  return STATE_CLASS[state] !== 'pre_publication';
}

export interface StateCopy {
  label: string;
  explanation: string;
  nextAction: string;
}

export const STATE_COPY: Record<State, StateCopy> = {
  draft: {
    label: 'Draft',
    explanation: 'Only you can see this. Nothing is shared until you send it to volunteer review.',
    nextAction: 'Prepare it, or discard.',
  },
  in_review: {
    label: 'In volunteer review',
    explanation: 'Your changes are back in review.',
    nextAction: 'Request publication again when ready.',
  },
  needs_revision: {
    label: 'Changes requested',
    explanation:
      'The publication check asked for changes before this can be published. Each note names the rule and sits next to the part it is about.',
    nextAction: 'Edit the marked fields and resubmit.',
  },
  held: {
    label: 'Waiting for the check',
    explanation:
      'The publication check could not finish. A held item waits rather than lowers the standard.',
    nextAction: 'Wait, or withdraw.',
  },
  rejected: {
    label: 'Not accepted',
    explanation: 'This was not accepted, for the reasons given. Your text is deleted on the date shown.',
    nextAction: 'Appeal before the date shown, or copy your text and start a new draft.',
  },
  // Label is a template, see activeLabel().
  active: {
    label: 'Active',
    explanation:
      "The community's rules were applied and this was published. Anyone can add options, questions and evidence to the stages.",
    nextAction: 'Contribute to the active stage, or to a later stage ahead of time.',
  },
  paused: {
    label: 'Paused',
    explanation: 'On hold: [reason]. Resumes when: [condition].',
    nextAction: 'Wait, or meet the condition.',
  },
  stuck: {
    label: 'Stuck',
    explanation: 'Documented work hit a blocker. The blocker and the next route are shown.',
    nextAction: 'Follow the escalation route or add information.',
  },
  solved: {
    label: 'Solved',
    explanation:
      'The rules for evidence were applied and the result meets the final criteria, using the evidence shown.',
    nextAction: 'Read the archive record.',
  },
  closed: {
    label: 'Closed',
    explanation: 'Closed because: [reason].',
    nextAction: 'Read the reason; appeal if you disagree.',
  },
  redirected: {
    label: 'Redirected',
    explanation: 'This is better handled by [destination]. Their route is shown.',
    nextAction: 'Use the route shown.',
  },
  withdrawn: {
    label: 'Withdrawn',
    explanation: 'You withdrew this. It was never public.',
    nextAction: 'Start a new draft if you wish.',
  },
};

export type ActiveStages = { kind: 'one'; name: string } | { kind: 'many'; n: number } | null;

export function activeLabel(stages: ActiveStages): string {
  if (!stages) return 'Active';
  if (stages.kind === 'one') return `Active: stage ${stages.name}`;
  // ICU plural: one {Active: # stage in progress} other {Active: # stages in progress}
  return stages.n === 1 ? 'Active: 1 stage in progress' : `Active: ${stages.n} stages in progress`;
}

/**
 * Policy versions look like `name@semver+<12 hex>` (policy module); shown as `v<semver>`.
 * Anything else is shown as given, with a `v` prefix unless it already has one.
 */
export function policyVersionLabel(policyVersion: string): string {
  const m = /^[^@]+@([^+]+)\+[0-9a-f]{12}$/.exec(policyVersion);
  if (m) return `v${m[1]}`;
  return /^v/i.test(policyVersion) ? policyVersion : `v${policyVersion}`;
}

export function decidedUnderLabel(state: State, policyVersion: string): string | null {
  if (state !== 'solved' && state !== 'closed' && state !== 'redirected') return null;
  return `Decided under policy ${policyVersionLabel(policyVersion)}`;
}

/** T20 / T21 reopen is a flag plus event, not a state. */
export function reopenedLabel(policyVersion: string): string {
  return `Reopened under policy ${policyVersionLabel(policyVersion)}`;
}

/** INTERIM-1: the deciding pack was ratified only by transitional founder stewardship. */
export function transitionalLabel(policyVersion: string): string {
  return `Policy ${policyVersionLabel(policyVersion)}, transitional stewardship`;
}
