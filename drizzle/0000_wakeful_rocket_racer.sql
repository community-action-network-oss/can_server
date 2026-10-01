CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"object_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"event_type" text NOT NULL,
	"origin_node_id" text NOT NULL,
	"actor" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"protocol_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"prev_hash" text
);
--> statement-breakpoint
CREATE INDEX "events_object_idx" ON "events" USING btree ("object_id","occurred_at");