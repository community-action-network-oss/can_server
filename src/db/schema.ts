import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
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
export const problem = pgTable(
  'problem',
  {
    id: uuid('id').primaryKey(),
    title: text('title').notNull(),
    state: text('state').notNull(),
    publishedAt: tz('published_at').notNull(),
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
  (t) => [index('problem_published_idx').on(t.publishedAt, t.id)],
);
