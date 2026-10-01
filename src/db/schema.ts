import {
  index,
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
