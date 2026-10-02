CREATE TABLE "moderation_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"target_version" integer NOT NULL,
	"dp_id" text NOT NULL,
	"mode" text NOT NULL,
	"trigger" text NOT NULL,
	"policy_version" text NOT NULL,
	"pack_hash" text NOT NULL,
	"stage_prompt_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stage_models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inputs_hash" "bytea",
	"outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"rule_ids" text[] DEFAULT '{}' NOT NULL,
	"field_ref" text,
	"revision_hint" text,
	"confidence" numeric,
	"public_explanation" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"cache" text DEFAULT 'bypass' NOT NULL,
	"status" text NOT NULL,
	"held_reason" text,
	"shadow" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_run_target_kind_chk" CHECK ("moderation_run"."target_kind" in ('problem','contribution','stage','archive_record')),
	CONSTRAINT "moderation_run_dp_chk" CHECK ("moderation_run"."dp_id" in ('DP-APPEAL','DP-ARCHIVE','DP-ASSUMPTIONS','DP-BLOCKER','DP-CLOSURE','DP-COMPLETENESS','DP-CONTRIB-RELEVANCE','DP-CRISIS','DP-CRITERIA','DP-DECISION-RECORD','DP-DUPLICATE','DP-ELIGIBILITY','DP-EVIDENCE-TIER','DP-FRAMING','DP-LEGAL','DP-LEGALITY','DP-NAMING','DP-PRIVACY','DP-PUBLISH','DP-RERESOLUTION','DP-REUSE-FIT','DP-SOURCE-TRUST','DP-STAGE-DRAFT','DP-STAGE-PLAN','DP-STAGE-RESOLUTION','DP-TONE','DP-VERIFICATION')),
	CONSTRAINT "moderation_run_mode_chk" CHECK ("moderation_run"."mode" in ('blocking','async')),
	CONSTRAINT "moderation_run_trigger_chk" CHECK ("moderation_run"."trigger" in ('submit_gate','publish','update','plan_change','stage_evidence','review','policy_change','context_change','sample','appeal','replay','advisory','re_resolution','archive','reuse')),
	CONSTRAINT "moderation_run_outcome_chk" CHECK ("moderation_run"."outcome" in ('publish','needs_revision','reject','route_external','hold','escalate_human')),
	CONSTRAINT "moderation_run_escalate_chk" CHECK ("moderation_run"."outcome" <> 'escalate_human' or "moderation_run"."dp_id" in ('DP-CRISIS','DP-LEGAL')),
	CONSTRAINT "moderation_run_rule_ids_chk" CHECK ("moderation_run"."outcome" not in ('needs_revision','reject') or cardinality("moderation_run"."rule_ids") > 0),
	CONSTRAINT "moderation_run_cache_chk" CHECK ("moderation_run"."cache" in ('hit','miss','bypass')),
	CONSTRAINT "moderation_run_status_chk" CHECK ("moderation_run"."status" in ('complete','held','failed','superseded')),
	CONSTRAINT "moderation_run_held_chk" CHECK ("moderation_run"."status" <> 'held' or ("moderation_run"."held_reason" is not null and "moderation_run"."held_reason" in ('provider_timeout','schema_invalid','low_confidence','language_unsupported','pack_missing','budget_exhausted','canary_tripped','gateway_failure','policy_conflict'))),
	CONSTRAINT "moderation_run_confidence_chk" CHECK ("moderation_run"."confidence" is null or ("moderation_run"."confidence" >= 0 and "moderation_run"."confidence" <= 1))
);
--> statement-breakpoint
ALTER TABLE "moderation_decision" DROP CONSTRAINT "moderation_decision_outcome_chk";--> statement-breakpoint
ALTER TABLE "moderation_decision" DROP CONSTRAINT "moderation_decision_explain_chk";--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD COLUMN "dp_id" text;--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD COLUMN "confidence" numeric;--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD COLUMN "prompt_hash" text;--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD COLUMN "transitional" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_run_key_uq" ON "moderation_run" USING btree ("target_id","target_version","dp_id","policy_version","trigger") WHERE "moderation_run"."shadow" = false;--> statement-breakpoint
CREATE INDEX "moderation_run_target_idx" ON "moderation_run" USING btree ("target_kind","target_id");--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD CONSTRAINT "moderation_decision_run_id_moderation_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."moderation_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD CONSTRAINT "moderation_decision_run_chk" CHECK ("moderation_decision"."outcome" in ('published','needs_revision','rejected') or "moderation_decision"."run_id" is not null);--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD CONSTRAINT "moderation_decision_escalate_chk" CHECK ("moderation_decision"."outcome" <> 'escalate_human' or "moderation_decision"."dp_id" in ('DP-CRISIS','DP-LEGAL'));--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD CONSTRAINT "moderation_decision_outcome_chk" CHECK ("moderation_decision"."outcome" in ('published','needs_revision','rejected','publish','reject','route_external','hold','escalate_human'));--> statement-breakpoint
ALTER TABLE "moderation_decision" ADD CONSTRAINT "moderation_decision_explain_chk" CHECK ("moderation_decision"."outcome" not in ('needs_revision','reject','rejected') or ("moderation_decision"."field_ref" is not null and ("moderation_decision"."revision_hint" is not null or "moderation_decision"."safety_sensitive")));
--> statement-breakpoint
-- moderation_run is immutable except two lifecycle columns. Chosen: a narrow column grant (no
-- SECURITY DEFINER function) on status and held_reason; superseded is status = 'superseded'.
-- DELETE is revoked; purge of a target's runs is an owner-role job. moderation_decision stays insert-only (0009).
REVOKE UPDATE, DELETE ON moderation_run FROM can_app_rw;
--> statement-breakpoint
GRANT UPDATE (status, held_reason) ON moderation_run TO can_app_rw;
