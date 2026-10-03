CREATE TABLE "decision_record" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"stage_choice_id" uuid NOT NULL,
	"method" text NOT NULL,
	"rationale" text NOT NULL,
	"decided_by" uuid NOT NULL,
	"authority" text NOT NULL,
	"dissent_notes" jsonb,
	"transitional" boolean DEFAULT false NOT NULL,
	"policy_version" text,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "decision_record_stage_choice_id_unique" UNIQUE("stage_choice_id"),
	CONSTRAINT "decision_record_text_chk" CHECK (length(btrim("decision_record"."rationale")) > 0 and length(btrim("decision_record"."authority")) > 0 and length(btrim("decision_record"."method")) > 0)
);
--> statement-breakpoint
CREATE TABLE "legal_gate_record" (
	"id" uuid PRIMARY KEY NOT NULL,
	"decision_record_id" uuid,
	"problem_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"findings" jsonb NOT NULL,
	"pack_version" text NOT NULL,
	"outcome" text NOT NULL,
	"constraint_text" text,
	"source_ref" text,
	"checked_by" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legal_gate_record_outcome_chk" CHECK ("legal_gate_record"."outcome" in ('clear','blocked')),
	CONSTRAINT "legal_gate_record_findings_chk" CHECK (jsonb_typeof("legal_gate_record"."findings") = 'array' and jsonb_array_length("legal_gate_record"."findings") = 6),
	CONSTRAINT "legal_gate_record_blocked_chk" CHECK ("legal_gate_record"."outcome" <> 'blocked' or ("legal_gate_record"."constraint_text" is not null and "legal_gate_record"."source_ref" is not null and jsonb_path_exists("legal_gate_record"."findings", '$[*] ? (@.blocks == true && exists(@.layer) && @.article_ids.size() > 0)')))
);
--> statement-breakpoint
ALTER TABLE "decision_record" ADD CONSTRAINT "decision_record_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_record" ADD CONSTRAINT "decision_record_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_record" ADD CONSTRAINT "decision_record_stage_choice_id_stage_choice_id_fk" FOREIGN KEY ("stage_choice_id") REFERENCES "public"."stage_choice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_record" ADD CONSTRAINT "decision_record_decided_by_account_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_gate_record" ADD CONSTRAINT "legal_gate_record_decision_record_id_decision_record_id_fk" FOREIGN KEY ("decision_record_id") REFERENCES "public"."decision_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_gate_record" ADD CONSTRAINT "legal_gate_record_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_gate_record" ADD CONSTRAINT "legal_gate_record_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_record_stage_idx" ON "decision_record" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "legal_gate_record_stage_idx" ON "legal_gate_record" USING btree ("stage_id");
--> statement-breakpoint
-- 04-u05: insert-only. The app role owns its tables, so a REVOKE alone does not bind it: the trigger does.
REVOKE UPDATE, DELETE, TRUNCATE ON decision_record, legal_gate_record FROM can_app_rw;
--> statement-breakpoint
CREATE FUNCTION decision_record_insert_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER decision_record_insert_only BEFORE UPDATE OR DELETE ON decision_record FOR EACH ROW EXECUTE FUNCTION decision_record_insert_only();
--> statement-breakpoint
CREATE TRIGGER legal_gate_record_insert_only BEFORE UPDATE OR DELETE ON legal_gate_record FOR EACH ROW EXECUTE FUNCTION decision_record_insert_only();
--> statement-breakpoint
CREATE TRIGGER decision_record_no_truncate BEFORE TRUNCATE ON decision_record FOR EACH STATEMENT EXECUTE FUNCTION decision_record_insert_only();
--> statement-breakpoint
CREATE TRIGGER legal_gate_record_no_truncate BEFORE TRUNCATE ON legal_gate_record FOR EACH STATEMENT EXECUTE FUNCTION decision_record_insert_only();
