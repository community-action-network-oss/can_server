CREATE TABLE "job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"class" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error_code" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "job_class_chk" CHECK ("job"."class" in ('crisis','prepub','update','async','sample')),
	CONSTRAINT "job_status_chk" CHECK ("job"."status" in ('queued','running','done','dead')),
	CONSTRAINT "job_attempts_chk" CHECK ("job"."attempt" >= 0 and "job"."max_attempts" >= 1),
	CONSTRAINT "job_lease_chk" CHECK ("job"."status" <> 'running' or "job"."lease_until" is not null)
);
--> statement-breakpoint
CREATE INDEX "job_claim_idx" ON "job" USING btree ("queue","status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_dedupe_uq" ON "job" USING btree ("dedupe_key") WHERE "job"."status" in ('queued','running');