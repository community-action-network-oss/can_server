CREATE TABLE "problem_version" (
	"problem_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "problem_version_problem_id_version_pk" PRIMARY KEY("problem_id","version")
);
--> statement-breakpoint
CREATE TABLE "review_recommendation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"path" text NOT NULL,
	"recommendation" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution_reason" text,
	"impact" text DEFAULT 'low' NOT NULL,
	"changed_at_version" integer,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_recommendation_status_chk" CHECK ("review_recommendation"."status" in ('open','accepted','declined')),
	CONSTRAINT "review_recommendation_impact_chk" CHECK ("review_recommendation"."impact" in ('low','high')),
	CONSTRAINT "review_recommendation_resolved_chk" CHECK ("review_recommendation"."status" = 'open' or ("review_recommendation"."resolution_reason" is not null and "review_recommendation"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "review_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"conflict_declared_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"access_ended_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_session_problem_reviewer_uq" UNIQUE("problem_id","reviewer_id"),
	CONSTRAINT "review_session_outcome_chk" CHECK ("review_session"."outcome" is null or "review_session"."outcome" in ('recommendations','no_changes')),
	CONSTRAINT "review_session_finished_chk" CHECK (("review_session"."finished_at" is null) = ("review_session"."outcome" is null))
);
--> statement-breakpoint
ALTER TABLE "problem_version" ADD CONSTRAINT "problem_version_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_recommendation" ADD CONSTRAINT "review_recommendation_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_recommendation" ADD CONSTRAINT "review_recommendation_reviewer_id_account_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_session" ADD CONSTRAINT "review_session_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_session" ADD CONSTRAINT "review_session_reviewer_id_account_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_recommendation_problem_idx" ON "review_recommendation" USING btree ("problem_id","status");--> statement-breakpoint
CREATE INDEX "review_recommendation_reviewer_idx" ON "review_recommendation" USING btree ("reviewer_id","created_at");--> statement-breakpoint
REVOKE DELETE ON review_recommendation FROM can_app_rw;
