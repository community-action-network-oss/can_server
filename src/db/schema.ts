import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  CONTRIBUTION_STATUSES,
  CONTRIBUTION_TYPES,
} from '../contributions/domain/types.js';
import { HOLD_REASONS } from '../moderation/domain/hold-reasons.js';
import { DP_IDS, OUTCOMES } from '../moderation/domain/outcome.js';

/** Append-only event log. Never UPDATE or DELETE rows. Mirrors domain/event.ts. */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    objectId: uuid('object_id').notNull(),
    objectType: text('object_type').notNull(),
    eventType: text('event_type').notNull(),
    originNodeId: text('origin_node_id').notNull(),
    actor: text('actor'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    protocolVersion: text('protocol_version').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    prevHash: text('prev_hash'),
  },
  (t) => [index('events_object_idx').on(t.objectId, t.occurredAt)],
);

// ponytail: bytea type lives here (not src/db/types.ts) because 02-u04 WRITES excludes that path.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** Identity. Email is stored only as ciphertext plus a keyed hash (IDENT-1). */
export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey(),
    emailCiphertext: bytea('email_ciphertext').notNull(),
    emailHmac: bytea('email_hmac').notNull().unique(),
    handle: text('handle').notNull().unique(),
    handleRegenerations: integer('handle_regenerations').notNull().default(0),
    role: text('role').notNull().default('member'),
    volunteerReviewer: boolean('volunteer_reviewer').notNull().default(false),
    volunteerReviewerSince: tz('volunteer_reviewer_since'),
    ageConfirmedAt: tz('age_confirmed_at'),
    createdAt: tz('created_at').notNull(),
    deletedAt: tz('deleted_at'),
    originNodeId: text('origin_node_id').notNull(),
    protocolVersion: text('protocol_version').notNull(),
  },
  (t) => [
    check('account_role_chk', sql`${t.role} in ('member','moderator','admin')`),
  ],
);

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    tokenHash: bytea('token_hash').notNull().unique(),
    expiresAt: tz('expires_at').notNull(),
    absoluteExpiresAt: tz('absolute_expires_at').notNull(),
    revokedAt: tz('revoked_at'),
    clientKind: text('client_kind').notNull(),
    lastSeenAt: tz('last_seen_at'),
  },
  (t) => [
    check('session_client_kind_chk', sql`${t.clientKind} in ('web','native')`),
  ],
);

export const invite = pgTable('invite', {
  id: uuid('id').primaryKey(),
  codeHash: bytea('code_hash').notNull().unique(),
  issuedBy: uuid('issued_by')
    .notNull()
    .references(() => account.id),
  redeemedBy: uuid('redeemed_by').references(() => account.id),
  expiresAt: tz('expires_at').notNull(),
  redeemedAt: tz('redeemed_at'),
});

export const loginCode = pgTable('login_code', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => account.id),
  codeHash: bytea('code_hash').notNull(),
  expiresAt: tz('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: tz('consumed_at'),
});

export const jurisdiction = pgTable('jurisdiction', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  parentId: uuid('parent_id'),
  isFictional: boolean('is_fictional').notNull().default(false),
  enabled: boolean('enabled').notNull().default(false),
  emergencyNotice: text('emergency_notice'),
  ruleSetVersion: text('rule_set_version'),
  originNodeId: text('origin_node_id').notNull(),
  protocolVersion: text('protocol_version').notNull(),
});

/** Append-only (insert-only grant, see roles_and_grants migration). */
export const auditEvent = pgTable('audit_event', {
  id: uuid('id').primaryKey(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
  transitional: boolean('transitional').notNull().default(false),
  ipClass: text('ip_class'),
  at: tz('at').notNull(),
  originNodeId: text('origin_node_id').notNull(),
  protocolVersion: text('protocol_version').notNull(),
  prevHash: text('prev_hash'),
});

/**
 * Public problems (read model for the plain list, D-80). help_needed describes the problem only;
 * nothing here is derived from any person. Writes arrive with the publication run.
 */
export interface KeptFlag {
  id: string;
  field: string;
  kind: string;
  ruleId: string;
  start: number;
  end: number;
}

export const problem = pgTable(
  'problem',
  {
    id: uuid('id').primaryKey(),
    // ponytail: nullable until the write path (plan 03) always sets it; OWN-1 forbids any owner column.
    initiatorId: uuid('initiator_id').references(() => account.id),
    schemaId: text('schema_id'),
    schemaVersion: text('schema_version'),
    schemaHash: text('schema_hash'),
    // Structured body validated against the pinned schema (10-u29); scrubbed with the other content on T19.
    content: jsonb('content').$type<Record<string, unknown>>(),
    planVersion: integer('plan_version').notNull().default(1),
    reviewRequestedAt: tz('review_requested_at'),
    // Submit checks (03-u08). Offsets and rule ids only, never text; keptFlags is the PRIV-GATE-1 evidence.
    privacyCheckId: uuid('privacy_check_id'),
    privacyCheckAt: tz('privacy_check_at'),
    keptFlags: jsonb('kept_flags').$type<KeptFlag[]>(),
    repostMatch: boolean('repost_match'),
    // Copy of the text fields at the last submit, with its version number (T01, T03); scrubbed with the other content.
    submitSnapshot: jsonb('submit_snapshot').$type<{
      version: number;
      fields: Record<string, unknown>;
    }>(),
    noSourceNote: text('no_source_note'),
    jurisdictionId: uuid('jurisdiction_id').references(() => jurisdiction.id),
    state: text('state').notNull(),
    // Content columns are nullable: drafts are partial and retention purges scrub them.
    title: text('title'),
    condition: text('condition'),
    affected: text('affected'),
    coarseArea: text('coarse_area'),
    desiredOutcome: text('desired_outcome'),
    observed: text('observed'),
    uncertain: text('uncertain'),
    evidenceTier: text('evidence_tier'),
    // Which writer set the tier: 'deterministic' (URL categories) or 'dp_evidence_tier' (a run's override; deterministic recompute leaves it alone).
    evidenceTierSource: text('evidence_tier_source'),
    investigationNeeded: boolean('investigation_needed')
      .notNull()
      .default(false),
    pendingTransition:
      jsonb('pending_transition').$type<Record<string, unknown>>(),
    resumeState: text('resume_state'),
    pauseReason: text('pause_reason'),
    resumeCondition: text('resume_condition'),
    duplicateOf: uuid('duplicate_of'),
    version: integer('version').notNull().default(1),
    publishedAt: tz('published_at'),
    tombstonedAt: tz('tombstoned_at'),
    withdrawnPublished: boolean('withdrawn_published').notNull().default(false),
    purgeAfter: tz('purge_after'),
    // Intake (03-u06): evidence as [{url, note}], plus lifecycle stamps.
    intakeEvidence:
      jsonb('intake_evidence').$type<{ url: string; note: string }[]>(),
    noEvidenceNote: text('no_evidence_note'),
    identifiersConfirmedAt: tz('identifiers_confirmed_at'),
    purgedAt: tz('purged_at'),
    reviewReminderSentAt: tz('review_reminder_sent_at'),
    // T19: problem_event is insert-only, so a discarded draft is scrubbed and stamped, not removed.
    deletedAt: tz('deleted_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
    isSeed: boolean('is_seed').notNull().default(false),
    syntheticEvidence: boolean('synthetic_evidence').notNull().default(false),
    helpNeeded: jsonb('help_needed')
      .$type<{
        skill_groups: string[];
        languages: string[];
        coarse_place: string | null;
        topics: string[];
      }>()
      .notNull(),
    originNodeId: text('origin_node_id').notNull(),
    protocolVersion: text('protocol_version').notNull(),
  },
  (t) => [
    index('problem_published_idx').on(t.publishedAt, t.id),
    index('problem_state_published_idx').on(t.state, t.publishedAt, t.id),
    index('problem_fts_idx').using(
      'gin',
      sql`to_tsvector('simple', coalesce(${t.title}, '') || ' ' || coalesce(${t.condition}, ''))`,
    ),
  ],
);

/** Append-only (insert-only grant, see the problem_event migration). */
export const problemEvent = pgTable('problem_event', {
  id: uuid('id').primaryKey(),
  problemId: uuid('problem_id')
    .notNull()
    .references(() => problem.id),
  type: text('type').notNull(),
  actorId: uuid('actor_id'),
  fromState: text('from_state'),
  toState: text('to_state'),
  reason: text('reason'),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  prevHash: text('prev_hash'),
  originNodeId: text('origin_node_id').notNull(),
  protocolVersion: text('protocol_version').notNull(),
  occurredAt: tz('occurred_at').notNull(),
});

/**
 * Repost fingerprints (system-design section 3). Deliberately NO foreign keys, no account id and
 * no problem id: only salted hashes of text shingles, purged by expiry (90 days).
 */
export const draftFingerprint = pgTable(
  'draft_fingerprint',
  {
    id: uuid('id').primaryKey(),
    hashes: text('hashes').array().notNull(),
    reason: text('reason').notNull(),
    createdAt: tz('created_at').notNull(),
    expiresAt: tz('expires_at').notNull(),
  },
  (t) => [
    check(
      'draft_fingerprint_reason_chk',
      sql`${t.reason} in ('rejected','withdrawn')`,
    ),
    index('draft_fingerprint_expires_idx').on(t.expiresAt),
  ],
);

/** Every content schema version the server has served or stamped (10-u29); `retired_at` set when another hash became active. */
export const contentSchemaVersion = pgTable(
  'content_schema_version',
  {
    type: text('type').notNull(),
    version: text('version').notNull(),
    packVersion: text('pack_version').notNull(),
    schemaHash: text('schema_hash').notNull(),
    activatedAt: tz('activated_at').notNull(),
    retiredAt: tz('retired_at'),
  },
  (t) => [primaryKey({ columns: [t.type, t.schemaHash] })],
);

/**
 * One row per moderation run decision (MOD-EXPLAIN-1). Insert-only for can_app_rw: a changed
 * outcome is a new row (NO-INSTANCE-OVERRIDE-1). No personal data, no human-decider or note columns.
 * `decided_by` is null for runs; `interim` is the legacy name 09-u03 replaces with `transitional`.
 */
export const moderationDecision = pgTable(
  'moderation_decision',
  {
    id: uuid('id').primaryKey(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    outcome: text('outcome').notNull(),
    ruleIds: text('rule_ids').array().notNull(),
    fieldRef: text('field_ref'),
    spanStart: integer('span_start'),
    spanEnd: integer('span_end'),
    revisionHint: text('revision_hint'),
    safetySensitive: boolean('safety_sensitive').notNull().default(false),
    policyVersion: text('policy_version').notNull(),
    publicExplanation: text('public_explanation').notNull(),
    appealableUntil: tz('appealable_until').notNull(),
    interim: boolean('interim').notNull().default(true),
    decidedBy: uuid('decided_by'),
    createdAt: tz('created_at').notNull().defaultNow(),
    // 09-u03: AI-run columns. `transitional` replaces `interim` (kept so old rows stay untouched).
    runId: uuid('run_id').references(() => moderationRun.id),
    dpId: text('dp_id'),
    confidence: numeric('confidence'),
    modelId: text('model_id'),
    promptHash: text('prompt_hash'),
    transitional: boolean('transitional').notNull().default(true),
    // Insert-only table: a later row cannot flag an earlier one, so this stays null unless set at insert.
    supersededBy: uuid('superseded_by'),
  },
  (t) => [
    check(
      'moderation_decision_target_type_chk',
      sql`${t.targetType} in ('problem','contribution')`,
    ),
    check(
      'moderation_decision_outcome_chk',
      sql`${t.outcome} in ('published','needs_revision','rejected','publish','reject','route_external','hold','escalate_human')`,
    ),
    // New AI outcomes must come from a run; legacy published/needs_revision/rejected may have none.
    check(
      'moderation_decision_run_chk',
      sql`${t.outcome} in ('published','needs_revision','rejected') or ${t.runId} is not null`,
    ),
    check(
      'moderation_decision_escalate_chk',
      sql`${t.outcome} <> 'escalate_human' or ${t.dpId} in ('DP-CRISIS','DP-LEGAL')`,
    ),
    check(
      'moderation_decision_rule_ids_chk',
      sql`cardinality(${t.ruleIds}) > 0`,
    ),
    check(
      'moderation_decision_span_chk',
      sql`(${t.spanStart} is null and ${t.spanEnd} is null) or (${t.spanStart} is not null and ${t.spanEnd} is not null and ${t.spanStart} < ${t.spanEnd})`,
    ),
    check(
      'moderation_decision_explain_chk',
      sql`${t.outcome} not in ('needs_revision','reject','rejected') or (${t.fieldRef} is not null and (${t.revisionHint} is not null or ${t.safetySensitive}))`,
    ),
    index('moderation_decision_target_idx').on(t.targetType, t.targetId),
  ],
);

/**
 * One immutable row per AI moderation run (runtime.md "Run record"). No raw text: outputs hold
 * offsets and codes. can_app_rw may INSERT and may UPDATE only status and held_reason (narrow
 * column grant, see the migration); DELETE is revoked.
 */
export const moderationRun = pgTable(
  'moderation_run',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id'),
    targetKind: text('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    targetVersion: integer('target_version').notNull(),
    dpId: text('dp_id').notNull(),
    mode: text('mode').notNull(),
    trigger: text('trigger').notNull(),
    policyVersion: text('policy_version').notNull(),
    packHash: text('pack_hash').notNull(),
    stagePromptHashes: jsonb('stage_prompt_hashes')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    stageModels: jsonb('stage_models')
      .$type<
        Record<
          string,
          { model_id: string; provider: string; route_reason: string }
        >
      >()
      .notNull()
      .default({}),
    inputsHash: bytea('inputs_hash'),
    outputs: jsonb('outputs')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // Null only while running, failed or superseded (09-u04, moderation_run_outcome_set_chk).
    outcome: text('outcome'),
    ruleIds: text('rule_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    fieldRef: text('field_ref'),
    revisionHint: text('revision_hint'),
    confidence: numeric('confidence'),
    publicExplanation: text('public_explanation'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' })
      .notNull()
      .default(0),
    cache: text('cache').notNull().default('bypass'),
    status: text('status').notNull(),
    heldReason: text('held_reason'),
    shadow: boolean('shadow').notNull().default(false),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'moderation_run_target_kind_chk',
      sql`${t.targetKind} in ('problem','contribution','stage','archive_record')`,
    ),
    check(
      'moderation_run_dp_chk',
      sql`${t.dpId} in (${sql.raw(DP_IDS.map((d) => `'${d}'`).join(','))})`,
    ),
    check('moderation_run_mode_chk', sql`${t.mode} in ('blocking','async')`),
    check(
      'moderation_run_trigger_chk',
      sql`${t.trigger} in ('submit_gate','publish','update','plan_change','stage_evidence','review','policy_change','context_change','sample','appeal','replay','advisory','re_resolution','archive','reuse')`,
    ),
    check(
      'moderation_run_outcome_chk',
      sql`${t.outcome} in (${sql.raw(OUTCOMES.map((o) => `'${o}'`).join(','))})`,
    ),
    check(
      'moderation_run_escalate_chk',
      sql`${t.outcome} <> 'escalate_human' or ${t.dpId} in ('DP-CRISIS','DP-LEGAL')`,
    ),
    check(
      'moderation_run_rule_ids_chk',
      sql`${t.outcome} not in ('needs_revision','reject') or cardinality(${t.ruleIds}) > 0`,
    ),
    check(
      'moderation_run_cache_chk',
      sql`${t.cache} in ('hit','miss','bypass')`,
    ),
    check(
      'moderation_run_status_chk',
      sql`${t.status} in ('running','complete','held','failed','superseded')`,
    ),
    check(
      'moderation_run_outcome_set_chk',
      sql`${t.outcome} is not null or ${t.status} in ('running','failed','superseded')`,
    ),
    check(
      'moderation_run_held_chk',
      sql`${t.status} <> 'held' or (${t.heldReason} is not null and ${t.heldReason} in (${sql.raw(HOLD_REASONS.map((h) => `'${h}'`).join(','))}))`,
    ),
    check(
      'moderation_run_confidence_chk',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    uniqueIndex('moderation_run_key_uq')
      .on(t.targetId, t.targetVersion, t.dpId, t.policyVersion, t.trigger)
      .where(sql`${t.shadow} = false`),
    index('moderation_run_target_idx').on(t.targetKind, t.targetId),
  ],
);

/**
 * One row per stage output of a run, stored as the stage finishes so a crashed run resumes
 * (09-u04). Insert-only; outputs are structured codes and offsets, never text.
 */
export const moderationRunStage = pgTable(
  'moderation_run_stage',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => moderationRun.id),
    stage: text('stage').notNull(),
    seq: integer('seq').notNull().default(0),
    output: jsonb('output').$type<Record<string, unknown>>().notNull(),
    modelId: text('model_id'),
    promptHash: text('prompt_hash'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'moderation_run_stage_pk',
      columns: [t.runId, t.stage, t.seq],
    }),
    check(
      'moderation_run_stage_output_chk',
      sql`jsonb_typeof(${t.output}) = 'object'`,
    ),
  ],
);

// ---- Stages (12-u02). Wire shapes are snake_case in `content`; columns hold what the server queries on. ----

const pinColumns = () => ({
  schemaId: text('schema_id'),
  schemaVersion: text('schema_version'),
  schemaHash: text('schema_hash'),
});

/** One node of a problem's stage plan. `name` is the plan slug; `label` is the display name. */
export const stage = pgTable(
  'stage',
  {
    id: uuid('id').primaryKey(),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problem.id),
    name: text('name').notNull(),
    label: text('label'),
    goal: text('goal').notNull(),
    state: text('state').notNull().default('planned'),
    decisionMethod: text('decision_method').notNull(),
    required: boolean('required').notNull().default(true),
    needsChoice: boolean('needs_choice').notNull().default(true),
    autoStart: boolean('auto_start').notNull().default(true),
    resumeState: text('resume_state'),
    planVersion: integer('plan_version').notNull().default(1),
    ordinal: integer('ordinal').notNull(),
    originNodeId: text('origin_node_id').notNull(),
    protocolVersion: text('protocol_version').notNull(),
  },
  (t) => [
    unique('stage_problem_name_uq').on(t.problemId, t.name),
    check(
      'stage_state_chk',
      sql`${t.state} in ('planned','ready','active','resolving','resolved','blocked','skipped')`,
    ),
    check(
      'stage_decision_method_chk',
      sql`${t.decisionMethod} in ('poster_after_input','community_vote','steward','other_named')`,
    ),
  ],
);

/** `stage_id` starts after `depends_on_id` is settled. */
export const stageEdge = pgTable(
  'stage_edge',
  {
    stageId: uuid('stage_id')
      .notNull()
      .references(() => stage.id),
    dependsOnId: uuid('depends_on_id')
      .notNull()
      .references(() => stage.id),
    planVersion: integer('plan_version').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.stageId, t.dependsOnId] }),
    check('stage_edge_self_chk', sql`${t.stageId} <> ${t.dependsOnId}`),
  ],
);

/** Owned by a problem (final criteria) or by a stage. */
export const acceptanceCriterion = pgTable(
  'acceptance_criterion',
  {
    id: uuid('id').primaryKey(),
    problemId: uuid('problem_id').references(() => problem.id),
    stageId: uuid('stage_id').references(() => stage.id),
    statement: text('statement').notNull(),
    measure: text('measure').notNull(),
    target: text('target'),
    evidenceHint: text('evidence_hint'),
    deadline: text('deadline'),
    metBy: jsonb('met_by').$type<string[]>().notNull().default([]),
    /** 0-based position inside its owner; the wire criterion_ref is ordinal + 1. */
    ordinal: integer('ordinal').notNull(),
  },
  (t) => [
    check(
      'acceptance_criterion_owner_chk',
      sql`(${t.problemId} is null) <> (${t.stageId} is null)`,
    ),
  ],
);

/** A trusted source cited by a problem (12-u04). `trust_result` is filled by DP-SOURCE-TRUST. Rows follow the draft content; the owning problem is never exposed (OWN-1). */
export const sourceRef = pgTable(
  'source_ref',
  {
    id: uuid('id').primaryKey(),
    problemId: uuid('problem_id').references(() => problem.id),
    stageEvidenceId: uuid('stage_evidence_id').references(
      () => stageEvidence.id,
    ),
    uri: text('uri').notNull(),
    category: text('category').notNull(),
    establishes: text('establishes').notNull(),
    authenticityNote: text('authenticity_note'),
    trustResult: jsonb('trust_result').$type<Record<string, unknown>>(),
    ordinal: integer('ordinal').notNull().default(0),
  },
  (t) => [
    uniqueIndex('source_ref_problem_uri_uq')
      .on(t.problemId, t.uri)
      .where(sql`${t.problemId} is not null`),
    check('source_ref_uri_chk', sql`${t.uri} like 'https://%'`),
    check(
      'source_ref_category_chk',
      sql`${t.category} in ('official_record','statistics_body','court_or_legislature','reputable_media','research','civil_society','other')`,
    ),
    check(
      'source_ref_owner_chk',
      sql`(${t.problemId} is null) <> (${t.stageEvidenceId} is null)`,
    ),
  ],
);

export const stageOption = pgTable(
  'stage_option',
  {
    id: uuid('id').primaryKey(),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => stage.id),
    contributionId: uuid('contribution_id'),
    authorId: uuid('author_id')
      .notNull()
      .references(() => account.id),
    mechanism: text('mechanism').notNull(),
    risks: text('risks').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    ...pinColumns(),
    status: text('status').notNull().default('pending'),
    forLaterStage: boolean('for_later_stage').notNull().default(false),
    createdAt: tz('created_at').notNull(),
  },
  (t) => [
    check(
      'stage_option_status_chk',
      sql`${t.status} in ('pending','public','hidden','withdrawn')`,
    ),
    index('stage_option_stage_idx').on(t.stageId),
  ],
);

export const stageChoice = pgTable(
  'stage_choice',
  {
    id: uuid('id').primaryKey(),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => stage.id),
    optionIds: jsonb('option_ids').$type<string[]>().notNull().default([]),
    steps: jsonb('steps').$type<unknown[]>(),
    decisionMethod: text('decision_method').notNull(),
    deciderId: uuid('decider_id')
      .notNull()
      .references(() => account.id),
    authority: text('authority').notNull(),
    rationale: text('rationale').notNull(),
    dissentNotes: jsonb('dissent_notes').$type<string[]>(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    ...pinColumns(),
    gateResult: jsonb('gate_result').$type<Record<string, unknown>>(),
    createdAt: tz('created_at').notNull(),
    withdrawnAt: tz('withdrawn_at'),
  },
  (t) => [
    uniqueIndex('stage_choice_live_uq')
      .on(t.stageId)
      .where(sql`${t.withdrawnAt} is null`),
  ],
);

/** Insert-only (REVOKE plus trigger, see the decision record migration). Withdrawal is read from `stage_choice.withdrawn_at`. */
export const decisionRecord = pgTable(
  'decision_record',
  {
    id: uuid('id').primaryKey(),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problem.id),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => stage.id),
    stageChoiceId: uuid('stage_choice_id')
      .notNull()
      .unique()
      .references(() => stageChoice.id),
    method: text('method').notNull(),
    rationale: text('rationale').notNull(),
    decidedBy: uuid('decided_by')
      .notNull()
      .references(() => account.id),
    authority: text('authority').notNull(),
    dissentNotes: jsonb('dissent_notes').$type<string[]>(),
    transitional: boolean('transitional').notNull().default(false),
    policyVersion: text('policy_version'),
    decidedAt: tz('decided_at').notNull(),
  },
  (t) => [
    check(
      'decision_record_text_chk',
      sql`length(btrim(${t.rationale})) > 0 and length(btrim(${t.authority})) > 0 and length(btrim(${t.method})) > 0`,
    ),
    index('decision_record_stage_idx').on(t.stageId),
  ],
);

/**
 * Insert-only. `findings` holds one entry per layer L1..L6: {layer, finding, corpus_version, article_ids, blocks}.
 * Article ids only, never article text. A blocked attempt has no decision record (the choice is not kept).
 */
export const legalGateRecord = pgTable(
  'legal_gate_record',
  {
    id: uuid('id').primaryKey(),
    decisionRecordId: uuid('decision_record_id').references(
      () => decisionRecord.id,
    ),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problem.id),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => stage.id),
    findings: jsonb('findings').$type<Record<string, unknown>[]>().notNull(),
    packVersion: text('pack_version').notNull(),
    outcome: text('outcome').notNull(),
    constraintText: text('constraint_text'),
    sourceRef: text('source_ref'),
    checkedBy: text('checked_by').notNull(),
    checkedAt: tz('checked_at').notNull(),
  },
  (t) => [
    check(
      'legal_gate_record_outcome_chk',
      sql`${t.outcome} in ('clear','blocked')`,
    ),
    check(
      'legal_gate_record_findings_chk',
      sql`jsonb_typeof(${t.findings}) = 'array' and jsonb_array_length(${t.findings}) = 6`,
    ),
    // LEGAL-GATE-1 and LEGAL-CITE-1: a block names its constraint, its source and a layer with article ids.
    check(
      'legal_gate_record_blocked_chk',
      sql`${t.outcome} <> 'blocked' or (${t.constraintText} is not null and ${t.sourceRef} is not null and jsonb_path_exists(${t.findings}, '$[*] ? (@.blocks == true && exists(@.layer) && @.article_ids.size() > 0)'))`,
    ),
    index('legal_gate_record_stage_idx').on(t.stageId),
  ],
);

/** One row per cited URL. STAGE-PREP-1: evidence is never accepted for a stage that is not active or blocked. */
export const stageEvidence = pgTable(
  'stage_evidence',
  {
    id: uuid('id').primaryKey(),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => stage.id),
    url: text('url').notNull(),
    kind: text('kind').notNull().default('url'),
    claimText: text('claim_text').notNull(),
    criteriaIds: jsonb('criteria_ids').$type<string[]>().notNull(),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => account.id),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    ...pinColumns(),
    tier: text('tier'),
    sourceTrust: jsonb('source_trust').$type<Record<string, unknown>>(),
    createdAt: tz('created_at').notNull(),
    frozenAt: tz('frozen_at'),
  },
  (t) => [index('stage_evidence_stage_idx').on(t.stageId)],
);

/** Append-only (insert-only grant, see the stages migration). */
export const stageEvent = pgTable('stage_event', {
  id: uuid('id').primaryKey(),
  stageId: uuid('stage_id')
    .notNull()
    .references(() => stage.id),
  problemId: uuid('problem_id')
    .notNull()
    .references(() => problem.id),
  type: text('type').notNull(),
  actorId: uuid('actor_id'),
  fromState: text('from_state'),
  toState: text('to_state'),
  reason: text('reason'),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  originNodeId: text('origin_node_id').notNull(),
  protocolVersion: text('protocol_version').notNull(),
  occurredAt: tz('occurred_at').notNull(),
});

/** A member's policy amendment proposal (10-u32). Stage moves also write `events` and `audit_event`; reports are the latest CI JSON. */
export const policyProposal = pgTable(
  'policy_proposal',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    schemaVersion: text('schema_version').notNull(),
    schemaHash: text('schema_hash').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    stage: text('stage').notNull().default('submitted'),
    prUrl: text('pr_url'),
    evalReport: jsonb('eval_report').$type<Record<string, unknown>>(),
    replayReport: jsonb('replay_report').$type<Record<string, unknown>>(),
    protectedCoreFlag: boolean('protected_core_flag').notNull().default(false),
    createdAt: tz('created_at').notNull(),
    updatedAt: tz('updated_at').notNull(),
  },
  (t) => [
    check(
      'policy_proposal_stage_chk',
      sql`${t.stage} in ('submitted','eval','replay','ratification','shadow','canary','full','rejected','withdrawn')`,
    ),
    index('policy_proposal_account_idx').on(t.accountId, t.createdAt),
    index('policy_proposal_stage_idx').on(t.stage, t.createdAt),
  ],
);

/**
 * Legal corpus versions the node has accepted (10-u55). One row per corpus id, version and hash.
 * Activating a version retires the previous active one of the same corpus; a refused corpus never gets a row.
 */
export const legalCorpusVersion = pgTable(
  'legal_corpus_version',
  {
    layer: text('layer').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    corpusId: text('corpus_id').notNull(),
    version: text('version').notNull(),
    hash: text('hash').notNull(),
    state: text('state').notNull(),
    activatedAt: tz('activated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.corpusId, t.version, t.hash] }),
    check(
      'legal_corpus_version_layer_chk',
      sql`${t.layer} in ('L1','L2','L3','L4','L5','L6')`,
    ),
    check(
      'legal_corpus_version_state_chk',
      sql`${t.state} in ('shadow','canary','active','retired')`,
    ),
    uniqueIndex('legal_corpus_version_active_uq')
      .on(t.jurisdiction, t.corpusId)
      .where(sql`${t.state} = 'active'`),
  ],
);

/** Additive human roles (09-u02). account.role stays as the single base role; none of these grant publish or override rights. */
export const accountRole = pgTable(
  'account_role',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    role: text('role').notNull(),
    grantedBy: uuid('granted_by').references(() => account.id),
    grantedAt: tz('granted_at').notNull(),
    revokedAt: tz('revoked_at'),
  },
  (t) => [
    check(
      'account_role_role_chk',
      sql`${t.role} in ('auditor','labeler','lane_member','steward')`,
    ),
    uniqueIndex('account_role_active_uq')
      .on(t.accountId, t.role)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/** Data model only: lets label and audit units refuse conflicted reviewers later. */
export const conflictDeclaration = pgTable('conflict_declaration', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => account.id),
  scope: text('scope').notNull(),
  createdAt: tz('created_at').notNull(),
});

/**
 * Postgres payload job queue (09-u05). Claimed with FOR UPDATE SKIP LOCKED. Payloads hold ids only;
 * last_error_code is a code, never a message.
 */
export const job = pgTable(
  'job',
  {
    id: uuid('id').primaryKey(),
    queue: text('queue').notNull(),
    class: text('class').notNull(),
    priority: integer('priority').notNull().default(100),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    runAt: tz('run_at').notNull(),
    status: text('status').notNull().default('queued'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    leaseUntil: tz('lease_until'),
    lastErrorCode: text('last_error_code'),
    dedupeKey: text('dedupe_key'),
    createdAt: tz('created_at').notNull(),
  },
  (t) => [
    check(
      'job_class_chk',
      sql`${t.class} in ('crisis','prepub','update','async','sample')`,
    ),
    check(
      'job_status_chk',
      sql`${t.status} in ('queued','running','done','dead')`,
    ),
    check('job_attempts_chk', sql`${t.attempt} >= 0 and ${t.maxAttempts} >= 1`),
    check(
      'job_lease_chk',
      sql`${t.status} <> 'running' or ${t.leaseUntil} is not null`,
    ),
    index('job_claim_idx').on(t.queue, t.status, t.runAt),
    uniqueIndex('job_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued','running')`),
  ],
);

/** Where the moderation event relay stopped, one row per source (09-u07). Mutable by design. */
export const relayCursor = pgTable('relay_cursor', {
  name: text('name').primaryKey(),
  lastId: uuid('last_id'),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/** Append-only (insert-only grant, see the 09-u07 migration). Platform-level moderation events with no problem row. */
export const moderationEvent = pgTable(
  'moderation_event',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    originNodeId: text('origin_node_id').notNull(),
    protocolVersion: text('protocol_version').notNull(),
    occurredAt: tz('occurred_at').notNull(),
  },
  (t) => [
    check(
      'moderation_event_type_chk',
      sql`${t.type} in ('policy_changed','sample_tick')`,
    ),
  ],
);

/**
 * Pseudonym token mapping (09-u09). The ciphertext is the ORIGINAL personal data, so this is personal data:
 * operation scoped, expiring, purgeable, never joined from run tables, never logged or serialised.
 * A trigger forbids UPDATE (the app role owns the table, so REVOKE alone is not enforced); DELETE is the purge.
 */
export const pseudonymToken = pgTable(
  'pseudonym_token',
  {
    id: uuid('id').primaryKey(),
    operationId: uuid('operation_id').notNull(),
    kind: text('kind').notNull(),
    token: text('token').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    expiresAt: tz('expires_at')
      .notNull()
      .default(sql`now() + interval '1 hour'`),
  },
  (t) => [
    unique('pseudonym_token_op_token_uq').on(t.operationId, t.token),
    index('pseudonym_token_expires_idx').on(t.expiresAt),
  ],
);

/** One volunteer's review of one problem (12-u03). Private (REVIEW-1): no public route reads this. */
export const reviewSession = pgTable(
  'review_session',
  {
    id: uuid('id').primaryKey(),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problem.id),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => account.id),
    conflictDeclaredAt: tz('conflict_declared_at').notNull(),
    finishedAt: tz('finished_at'),
    outcome: text('outcome'),
    /** T05, T06, T07: the volunteer can no longer open the problem. */
    accessEndedAt: tz('access_ended_at'),
    createdAt: tz('created_at').notNull(),
  },
  (t) => [
    unique('review_session_problem_reviewer_uq').on(t.problemId, t.reviewerId),
    check(
      'review_session_outcome_chk',
      sql`${t.outcome} is null or ${t.outcome} in ('recommendations','no_changes')`,
    ),
    check(
      'review_session_finished_chk',
      sql`(${t.finishedAt} is null) = (${t.outcome} is null)`,
    ),
  ],
);

/**
 * A volunteer recommendation on one field or metadata path (12-u03, RECO-1). Private volunteer content.
 * Rows are never deleted (REVOKE DELETE in the migration); history stays through `status`.
 */
export const reviewRecommendation = pgTable(
  'review_recommendation',
  {
    id: uuid('id').primaryKey(),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problem.id),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => account.id),
    path: text('path').notNull(),
    /** Masked text (the privacy gateway ran before it was stored). */
    recommendation: text('recommendation').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('open'),
    resolutionReason: text('resolution_reason'),
    impact: text('impact').notNull().default('low'),
    /** The problem version in which this path last changed after the recommendation was made. */
    changedAtVersion: integer('changed_at_version'),
    /** Starts the open-age clock; reset when T03 reopens it. */
    openedAt: tz('opened_at').notNull(),
    resolvedAt: tz('resolved_at'),
    createdAt: tz('created_at').notNull(),
    updatedAt: tz('updated_at').notNull(),
  },
  (t) => [
    check(
      'review_recommendation_status_chk',
      sql`${t.status} in ('open','accepted','declined')`,
    ),
    check(
      'review_recommendation_impact_chk',
      sql`${t.impact} in ('low','high')`,
    ),
    check(
      'review_recommendation_resolved_chk',
      sql`${t.status} = 'open' or (${t.resolutionReason} is not null and ${t.resolvedAt} is not null)`,
    ),
    index('review_recommendation_problem_idx').on(t.problemId, t.status),
    index('review_recommendation_reviewer_idx').on(t.reviewerId, t.createdAt),
  ],
);

/**
 * Copy of the problem text at a version seen in review, so "changed since" can be shown (12-u03).
 * User content: deleted with the problem and when volunteer access ends (T05, T06, T07).
 */
export const problemVersion = pgTable(
  'problem_version',
  {
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problem.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    createdAt: tz('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.problemId, t.version] })],
);

const inList = (xs: readonly string[]) =>
  sql.raw(`(${xs.map((x) => `'${x}'`).join(',')})`);

/**
 * A typed contribution aimed at a stage (stage_id) or the whole problem (null).
 * body is the structured answers (pinned content schema); there is no free-form text column.
 * Exactly one of author_id / system_actor is set (a system actor such as news_watch carries a label, D-79).
 */
export const contribution = pgTable(
  'contribution',
  {
    id: uuid('id').primaryKey(),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problem.id),
    stageId: uuid('stage_id').references(() => stage.id),
    forLaterStage: boolean('for_later_stage').notNull().default(false),
    authorId: uuid('author_id').references(() => account.id),
    systemActor: text('system_actor'),
    type: text('type').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    ...pinColumns(),
    status: text('status').notNull().default('pending_review'),
    lastRunId: uuid('last_run_id'),
    answersContributionId: uuid('answers_contribution_id').references(
      (): AnyPgColumn => contribution.id,
    ),
    /** A proposal_improvement points at the stage option it improves (D-74). */
    improvesOptionId: uuid('improves_option_id').references(
      () => stageOption.id,
    ),
    createdAt: tz('created_at').notNull(),
    reviewedAt: tz('reviewed_at'),
    tombstonedAt: tz('tombstoned_at'),
    originNodeId: text('origin_node_id').notNull(),
    protocolVersion: text('protocol_version').notNull(),
  },
  (t) => [
    index('contribution_problem_idx').on(
      t.problemId,
      t.status,
      t.type,
      t.createdAt,
    ),
    index('contribution_stage_idx').on(
      t.stageId,
      t.status,
      t.type,
      t.createdAt,
    ),
    check(
      'contribution_type_chk',
      sql`${t.type} in ${inList(CONTRIBUTION_TYPES)}`,
    ),
    check(
      'contribution_status_chk',
      sql`${t.status} in ${inList(CONTRIBUTION_STATUSES)}`,
    ),
    check(
      'contribution_actor_chk',
      sql`(${t.authorId} is null) <> (${t.systemActor} is null)`,
    ),
  ],
);

/** One cited URL per row. URLs only, never files (EVID-URL-1). */
export const evidenceRef = pgTable(
  'evidence_ref',
  {
    id: uuid('id').primaryKey(),
    contributionId: uuid('contribution_id')
      .notNull()
      .references(() => contribution.id),
    url: text('url').notNull(),
    note: text('note'),
    kind: text('kind').notNull().default('url'),
    tier: smallint('tier'),
    attestation: text('attestation'),
    addedAt: tz('added_at').notNull(),
  },
  (t) => [index('evidence_ref_contribution_idx').on(t.contributionId)],
);

/**
 * Explicit, per-problem follow (04-u07). Never inferred from behaviour or the capability profile (D-80).
 * No counters anywhere. Cascades with the account or problem row.
 */
export const follow = pgTable(
  'follow',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problem.id, { onDelete: 'cascade' }),
    createdAt: tz('created_at').notNull(),
    mutedAt: tz('muted_at'),
    /** Set only while the account holds an active `problem_updates_email` consent. */
    mailConsentAt: tz('mail_consent_at'),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.problemId] })],
);

/** In-app notification. `label` is fixed public wording (a state or stage label), never user text. */
export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problem.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** The problem_event or stage_event id; the pair with account_id dedupes a re-run. */
    eventId: uuid('event_id').notNull(),
    label: text('label').notNull(),
    createdAt: tz('created_at').notNull(),
    readAt: tz('read_at'),
  },
  (t) => [
    unique('notification_account_event_uq').on(t.accountId, t.eventId),
    index('notification_account_idx').on(t.accountId, t.createdAt, t.id),
  ],
);

/** NOTIFY-CONSENT-1 evidence: purpose and timestamps. Revoking sets revoked_at; a new grant is a new row. */
export const consentRecord = pgTable(
  'consent_record',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    grantedAt: tz('granted_at').notNull(),
    revokedAt: tz('revoked_at'),
  },
  (t) => [index('consent_record_account_idx').on(t.accountId, t.purpose)],
);
