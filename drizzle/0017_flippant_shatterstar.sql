CREATE TABLE "moderation_run_stage" (
	"run_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"output" jsonb NOT NULL,
	"model_id" text,
	"prompt_hash" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_run_stage_pk" PRIMARY KEY("run_id","stage","seq"),
	CONSTRAINT "moderation_run_stage_output_chk" CHECK (jsonb_typeof("moderation_run_stage"."output") = 'object')
);
--> statement-breakpoint
ALTER TABLE "moderation_run" DROP CONSTRAINT "moderation_run_status_chk";--> statement-breakpoint
ALTER TABLE "moderation_run" ALTER COLUMN "outcome" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_run_stage" ADD CONSTRAINT "moderation_run_stage_run_id_moderation_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."moderation_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_run" ADD CONSTRAINT "moderation_run_outcome_set_chk" CHECK ("moderation_run"."outcome" is not null or "moderation_run"."status" in ('running','failed','superseded'));--> statement-breakpoint
ALTER TABLE "moderation_run" ADD CONSTRAINT "moderation_run_status_chk" CHECK ("moderation_run"."status" in ('running','complete','held','failed','superseded'));--> statement-breakpoint
-- 09-u04: a running run is filled in as stages finish. can_app_rw may update only the
-- lifecycle/decision columns; a trigger freezes them again once status leaves 'running'
-- (status and held_reason stay updatable, as in 0015). Error code 42501 = permission denied.
GRANT UPDATE (outcome, rule_ids, field_ref, revision_hint, confidence, public_explanation, tokens_in, tokens_out, latency_ms, cost_micro_usd, cache, inputs_hash, outputs, stage_prompt_hashes, stage_models) ON moderation_run TO can_app_rw;
--> statement-breakpoint
CREATE FUNCTION moderation_run_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'running' AND (
    NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.rule_ids IS DISTINCT FROM OLD.rule_ids
    OR NEW.field_ref IS DISTINCT FROM OLD.field_ref OR NEW.revision_hint IS DISTINCT FROM OLD.revision_hint
    OR NEW.confidence IS DISTINCT FROM OLD.confidence OR NEW.public_explanation IS DISTINCT FROM OLD.public_explanation
    OR NEW.tokens_in IS DISTINCT FROM OLD.tokens_in OR NEW.tokens_out IS DISTINCT FROM OLD.tokens_out
    OR NEW.latency_ms IS DISTINCT FROM OLD.latency_ms OR NEW.cost_micro_usd IS DISTINCT FROM OLD.cost_micro_usd
    OR NEW.cache IS DISTINCT FROM OLD.cache OR NEW.inputs_hash IS DISTINCT FROM OLD.inputs_hash
    OR NEW.outputs IS DISTINCT FROM OLD.outputs OR NEW.stage_prompt_hashes IS DISTINCT FROM OLD.stage_prompt_hashes
    OR NEW.stage_models IS DISTINCT FROM OLD.stage_models
  ) THEN
    RAISE EXCEPTION 'permission denied for table moderation_run: immutable once not running' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER moderation_run_freeze BEFORE UPDATE ON moderation_run FOR EACH ROW EXECUTE FUNCTION moderation_run_freeze();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON moderation_run_stage FROM can_app_rw;
