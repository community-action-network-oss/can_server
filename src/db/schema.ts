import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

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
    check('draft_fingerprint_reason_chk', sql`${t.reason} in ('rejected','withdrawn')`),
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
