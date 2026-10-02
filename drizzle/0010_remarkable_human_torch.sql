CREATE TABLE "acceptance_criterion" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid,
	"stage_id" uuid,
	"statement" text NOT NULL,
	"measure" text NOT NULL,
	"target" text,
	"evidence_hint" text,
	"deadline" text,
	"met_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "acceptance_criterion_owner_chk" CHECK (("acceptance_criterion"."problem_id" is null) <> ("acceptance_criterion"."stage_id" is null))
);
--> statement-breakpoint
CREATE TABLE "stage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"name" text NOT NULL,
	"label" text,
	"goal" text NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"decision_method" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"needs_choice" boolean DEFAULT true NOT NULL,
	"auto_start" boolean DEFAULT true NOT NULL,
	"resume_state" text,
	"plan_version" integer DEFAULT 1 NOT NULL,
	"ordinal" integer NOT NULL,
	"origin_node_id" text NOT NULL,
	"protocol_version" text NOT NULL,
	CONSTRAINT "stage_problem_name_uq" UNIQUE("problem_id","name"),
	CONSTRAINT "stage_state_chk" CHECK ("stage"."state" in ('planned','ready','active','resolving','resolved','blocked','skipped')),
	CONSTRAINT "stage_decision_method_chk" CHECK ("stage"."decision_method" in ('poster_after_input','community_vote','steward','other_named'))
);
--> statement-breakpoint
CREATE TABLE "stage_choice" (
	"id" uuid PRIMARY KEY NOT NULL,
	"stage_id" uuid NOT NULL,
	"option_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb,
	"decision_method" text NOT NULL,
	"decider_id" uuid NOT NULL,
	"authority" text NOT NULL,
	"rationale" text NOT NULL,
	"dissent_notes" jsonb,
	"content" jsonb NOT NULL,
	"schema_id" text,
	"schema_version" text,
	"schema_hash" text,
	"gate_result" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stage_edge" (
	"stage_id" uuid NOT NULL,
	"depends_on_id" uuid NOT NULL,
	"plan_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stage_edge_stage_id_depends_on_id_pk" PRIMARY KEY("stage_id","depends_on_id"),
	CONSTRAINT "stage_edge_self_chk" CHECK ("stage_edge"."stage_id" <> "stage_edge"."depends_on_id")
);
--> statement-breakpoint
CREATE TABLE "stage_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"stage_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_id" uuid,
	"from_state" text,
	"to_state" text,
	"reason" text,
	"payload" jsonb,
	"origin_node_id" text NOT NULL,
	"protocol_version" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"stage_id" uuid NOT NULL,
	"url" text NOT NULL,
	"kind" text DEFAULT 'url' NOT NULL,
	"claim_text" text NOT NULL,
	"criteria_ids" jsonb NOT NULL,
	"submitted_by" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"schema_id" text,
	"schema_version" text,
	"schema_hash" text,
	"tier" text,
	"source_trust" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"frozen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stage_option" (
	"id" uuid PRIMARY KEY NOT NULL,
	"stage_id" uuid NOT NULL,
	"contribution_id" uuid,
	"author_id" uuid NOT NULL,
	"mechanism" text NOT NULL,
	"risks" text NOT NULL,
	"content" jsonb NOT NULL,
	"schema_id" text,
	"schema_version" text,
	"schema_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"for_later_stage" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stage_option_status_chk" CHECK ("stage_option"."status" in ('pending','public','hidden','withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "acceptance_criterion" ADD CONSTRAINT "acceptance_criterion_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_criterion" ADD CONSTRAINT "acceptance_criterion_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage" ADD CONSTRAINT "stage_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_choice" ADD CONSTRAINT "stage_choice_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_choice" ADD CONSTRAINT "stage_choice_decider_id_account_id_fk" FOREIGN KEY ("decider_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_edge" ADD CONSTRAINT "stage_edge_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_edge" ADD CONSTRAINT "stage_edge_depends_on_id_stage_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_event" ADD CONSTRAINT "stage_event_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_event" ADD CONSTRAINT "stage_event_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_evidence" ADD CONSTRAINT "stage_evidence_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_evidence" ADD CONSTRAINT "stage_evidence_submitted_by_account_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_option" ADD CONSTRAINT "stage_option_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_option" ADD CONSTRAINT "stage_option_author_id_account_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stage_choice_live_uq" ON "stage_choice" USING btree ("stage_id") WHERE "stage_choice"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "stage_evidence_stage_idx" ON "stage_evidence" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "stage_option_stage_idx" ON "stage_option" USING btree ("stage_id");--> statement-breakpoint
REVOKE UPDATE, DELETE ON stage_event FROM can_app_rw;
