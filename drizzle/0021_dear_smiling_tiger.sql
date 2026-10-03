CREATE TABLE "contribution" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"stage_id" uuid,
	"for_later_stage" boolean DEFAULT false NOT NULL,
	"author_id" uuid,
	"system_actor" text,
	"type" text NOT NULL,
	"body" jsonb NOT NULL,
	"schema_id" text,
	"schema_version" text,
	"schema_hash" text,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"last_run_id" uuid,
	"answers_contribution_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"reviewed_at" timestamp with time zone,
	"tombstoned_at" timestamp with time zone,
	"origin_node_id" text NOT NULL,
	"protocol_version" text NOT NULL,
	CONSTRAINT "contribution_type_chk" CHECK ("contribution"."type" in ('clarifying_question','observation','personal_experience','factual_claim','evidence','interpretation','root_cause','constraint','stakeholder_perspective','proposed_solution','proposal_improvement','risk','implementation_offer','progress_update','verification_evidence','moderation_feedback')),
	CONSTRAINT "contribution_status_chk" CHECK ("contribution"."status" in ('pending_review','accepted','hidden','tombstoned')),
	CONSTRAINT "contribution_actor_chk" CHECK (("contribution"."author_id" is null) <> ("contribution"."system_actor" is null))
);
--> statement-breakpoint
CREATE TABLE "evidence_ref" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contribution_id" uuid NOT NULL,
	"url" text NOT NULL,
	"note" text,
	"kind" text DEFAULT 'url' NOT NULL,
	"tier" smallint,
	"attestation" text,
	"added_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contribution" ADD CONSTRAINT "contribution_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution" ADD CONSTRAINT "contribution_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution" ADD CONSTRAINT "contribution_author_id_account_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution" ADD CONSTRAINT "contribution_answers_contribution_id_contribution_id_fk" FOREIGN KEY ("answers_contribution_id") REFERENCES "public"."contribution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_ref" ADD CONSTRAINT "evidence_ref_contribution_id_contribution_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."contribution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contribution_problem_idx" ON "contribution" USING btree ("problem_id","status","type","created_at");--> statement-breakpoint
CREATE INDEX "contribution_stage_idx" ON "contribution" USING btree ("stage_id","status","type","created_at");--> statement-breakpoint
CREATE INDEX "evidence_ref_contribution_idx" ON "evidence_ref" USING btree ("contribution_id");