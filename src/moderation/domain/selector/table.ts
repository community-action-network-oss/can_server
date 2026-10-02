import type { DpId } from '../outcome.js';
import {
  CONTENT_TYPES,
  TEXT_EVENTS,
  type ContentType,
  type DpMode,
  type EventKind,
} from './events.js';

/**
 * decision-points.md "Catalog" and "Which DPs apply to which content type", plus triggers.md section 2, as data.
 * `Record<DpId, ...>` makes a DP added to DP_IDS without a row a compile error.
 * `fields` narrows an `edited` event by changed field per content type; no entry means any changed field.
 */
export interface DpRule {
  types: readonly ContentType[];
  on: Partial<Record<EventKind, DpMode>>;
  fields?: Partial<Record<ContentType, readonly string[]>>;
}

/** review_recommendation is private volunteer content: only the four always-on DPs below list it. */
const NO_REC = CONTENT_TYPES.filter((t) => t !== 'review_recommendation');
const ALL = CONTENT_TYPES;

const b = (...e: EventKind[]): Partial<Record<EventKind, DpMode>> =>
  Object.fromEntries(e.map((k) => [k, 'blocking' as const]));
const text = b(...TEXT_EVENTS);
/** Post-publication re-moderation and sampling (triggers.md section 3): async, never blocking. */
const REPLAY: Partial<Record<EventKind, DpMode>> = {
  policy_changed: 'async',
  sample_tick: 'async',
};

const PROSE = [
  'condition',
  'affected',
  'desired_outcome',
  'observed_facts',
  'uncertain_claims',
  'causal_hypothesis',
  'existing_efforts',
];

export const SELECTOR_TABLE: Record<DpId, DpRule> = {
  'DP-CRISIS': { types: ALL, on: { ...text, ...REPLAY } },
  'DP-LEGAL': { types: NO_REC, on: { ...text, ...REPLAY } },
  'DP-PRIVACY': { types: ALL, on: { ...text, ...REPLAY } },
  'DP-NAMING': {
    types: ALL,
    on: { ...text, ...REPLAY },
    fields: { problem: PROSE },
  },
  'DP-TONE': {
    types: ALL,
    on: { ...text, ...REPLAY },
    fields: { problem: PROSE },
  },
  'DP-ASSUMPTIONS': { types: NO_REC, on: { ...text, ...REPLAY } },
  'DP-COMPLETENESS': { types: NO_REC, on: { ...text, ...REPLAY } },
  'DP-ELIGIBILITY': {
    types: ['problem'],
    on: { ...b('review_requested'), ...REPLAY },
  },
  'DP-FRAMING': {
    types: ['problem'],
    on: {
      ...b('review_requested', 'publication_requested', 'edited'),
      ...REPLAY,
    },
    fields: { problem: [...PROSE.slice(0, 4), 'scope'] },
  },
  'DP-DUPLICATE': {
    types: ['problem'],
    on: {
      ...b(
        'review_requested',
        'publication_requested',
        'edited',
        'close_proposed',
      ),
      context_changed: 'async',
      ...REPLAY,
    },
    fields: {
      problem: ['condition', 'affected', 'place', 'scope', 'affected_area'],
    },
  },
  'DP-SOURCE-TRUST': {
    types: ['problem'],
    on: {
      ...b('review_requested', 'publication_requested', 'edited'),
      ...REPLAY,
    },
    fields: { problem: ['sources'] },
  },
  'DP-CRITERIA': {
    types: ['problem', 'stage'],
    on: {
      ...b(
        'review_requested',
        'publication_requested',
        'edited',
        'plan_change_proposed',
      ),
      ...REPLAY,
    },
    fields: {
      problem: ['final_acceptance_criteria', 'desired_outcome'],
      stage: ['criteria', 'goal'],
    },
  },
  'DP-STAGE-PLAN': {
    types: ['problem', 'stage'],
    on: {
      ...b('review_requested', 'publication_requested', 'plan_change_proposed'),
      ...REPLAY,
    },
  },
  'DP-PUBLISH': { types: ['problem'], on: b('publication_requested') },
  'DP-CONTRIB-RELEVANCE': {
    types: ['contribution', 'stage_option'],
    on: {
      ...b('contribution_submitted', 'stage_option_ready', 'edited'),
      ...REPLAY,
    },
  },
  'DP-LEGALITY': {
    types: [
      'contribution',
      'proposal',
      'decision_record',
      'stage_option',
      'stage_choice',
    ],
    on: {
      ...b(
        'contribution_submitted',
        'stage_option_ready',
        'stage_choice_recorded',
        'edited',
      ),
      context_changed: 'async',
      ...REPLAY,
    },
  },
  'DP-DECISION-RECORD': {
    types: ['decision_record', 'stage_choice'],
    on: { ...b('stage_choice_recorded', 'edited'), ...REPLAY },
  },
  'DP-EVIDENCE-TIER': {
    types: [
      'problem',
      'contribution',
      'proposal',
      'task_verification',
      'appeal',
      'stage_evidence',
    ],
    on: {
      ...b(
        'edited',
        'contribution_submitted',
        'stage_evidence_submitted',
        'solved_proposed',
      ),
      context_changed: 'async',
      ...REPLAY,
    },
    fields: {
      problem: ['evidence_refs', 'sources'],
      contribution: [
        'url',
        'source_description',
        'evidence_refs',
        'source_ref',
      ],
      proposal: ['evidence_refs'],
      appeal: ['new_evidence_refs'],
      stage_evidence: ['evidence_refs'],
    },
  },
  'DP-STAGE-RESOLUTION': {
    types: ['stage', 'stage_evidence'],
    on: { ...b('stage_evidence_submitted'), policy_changed: 'async' },
  },
  'DP-VERIFICATION': {
    types: ['problem', 'contribution', 'task_verification'],
    on: b('solved_proposed'),
  },
  'DP-BLOCKER': {
    types: [
      'problem',
      'proposal',
      'decision_record',
      'task_verification',
      'stage',
    ],
    on: b('stuck_proposed'),
  },
  'DP-CLOSURE': {
    types: [
      'problem',
      'proposal',
      'decision_record',
      'task_verification',
      'stage',
    ],
    on: b('close_proposed'),
  },
  'DP-APPEAL': { types: ['appeal'], on: { appeal_filed: 'async' } },
  'DP-RERESOLUTION': {
    types: ['problem', 'decision_record', 'stage'],
    on: { policy_changed: 'async' },
  },
  'DP-ARCHIVE': { types: ['problem'], on: b('problem_ended') },
  'DP-REUSE-FIT': { types: ['problem'], on: b('suggestion_requested') },
  'DP-STAGE-DRAFT': {
    types: ['problem', 'stage'],
    on: b('stage_draft_requested'),
  },
};

/** Run order: crisis and legal first (triggers.md priority), then the rest in table order. */
export const TABLE_ORDER = Object.keys(SELECTOR_TABLE) as DpId[];
