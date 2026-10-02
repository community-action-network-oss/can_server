CREATE TABLE "source_ref" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid,
	"stage_evidence_id" uuid,
	"uri" text NOT NULL,
	"category" text NOT NULL,
	"establishes" text NOT NULL,
	"authenticity_note" text,
	"trust_result" jsonb,
	"ordinal" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "source_ref_uri_chk" CHECK ("source_ref"."uri" like 'https://%'),
	CONSTRAINT "source_ref_category_chk" CHECK ("source_ref"."category" in ('official_record','statistics_body','court_or_legislature','reputable_media','research','civil_society','other')),
	CONSTRAINT "source_ref_owner_chk" CHECK (("source_ref"."problem_id" is null) <> ("source_ref"."stage_evidence_id" is null))
);
--> statement-breakpoint
ALTER TABLE "source_ref" ADD CONSTRAINT "source_ref_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_ref" ADD CONSTRAINT "source_ref_stage_evidence_id_stage_evidence_id_fk" FOREIGN KEY ("stage_evidence_id") REFERENCES "public"."stage_evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_ref_problem_uri_uq" ON "source_ref" USING btree ("problem_id","uri") WHERE "source_ref"."problem_id" is not null;