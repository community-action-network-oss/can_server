CREATE TABLE "policy_proposal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"schema_version" text NOT NULL,
	"schema_hash" text NOT NULL,
	"body" jsonb NOT NULL,
	"stage" text DEFAULT 'submitted' NOT NULL,
	"pr_url" text,
	"eval_report" jsonb,
	"replay_report" jsonb,
	"protected_core_flag" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "policy_proposal_stage_chk" CHECK ("policy_proposal"."stage" in ('submitted','eval','replay','ratification','shadow','canary','full','rejected','withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "policy_proposal" ADD CONSTRAINT "policy_proposal_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "policy_proposal_account_idx" ON "policy_proposal" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "policy_proposal_stage_idx" ON "policy_proposal" USING btree ("stage","created_at");