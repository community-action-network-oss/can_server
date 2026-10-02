CREATE TABLE "moderation_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"origin_node_id" text NOT NULL,
	"protocol_version" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "moderation_event_type_chk" CHECK ("moderation_event"."type" in ('policy_changed','sample_tick'))
);
--> statement-breakpoint
CREATE TABLE "relay_cursor" (
	"name" text PRIMARY KEY NOT NULL,
	"last_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
REVOKE UPDATE, DELETE ON moderation_event FROM can_app_rw;
