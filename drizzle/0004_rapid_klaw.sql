CREATE TABLE "problem_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_id" uuid,
	"from_state" text,
	"to_state" text,
	"reason" text,
	"payload" jsonb,
	"prev_hash" text,
	"origin_node_id" text NOT NULL,
	"protocol_version" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "problem" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "problem" ALTER COLUMN "published_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "initiator_id" uuid;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "schema_id" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "schema_version" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "schema_hash" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "plan_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "review_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "no_source_note" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "jurisdiction_id" uuid;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "condition" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "affected" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "coarse_area" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "desired_outcome" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "observed" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "uncertain" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "evidence_tier" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "investigation_needed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "pending_transition" jsonb;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "resume_state" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "resume_condition" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "duplicate_of" uuid;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "tombstoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "withdrawn_published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "is_seed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "synthetic_evidence" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "problem_event" ADD CONSTRAINT "problem_event_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem" ADD CONSTRAINT "problem_initiator_id_account_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem" ADD CONSTRAINT "problem_jurisdiction_id_jurisdiction_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdiction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "problem_state_published_idx" ON "problem" USING btree ("state","published_at","id");--> statement-breakpoint
CREATE INDEX "problem_fts_idx" ON "problem" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("condition", '')));--> statement-breakpoint
REVOKE UPDATE, DELETE ON problem_event FROM can_app_rw;
