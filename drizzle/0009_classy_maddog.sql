CREATE TABLE "moderation_decision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"rule_ids" text[] NOT NULL,
	"field_ref" text,
	"span_start" integer,
	"span_end" integer,
	"revision_hint" text,
	"safety_sensitive" boolean DEFAULT false NOT NULL,
	"policy_version" text NOT NULL,
	"public_explanation" text NOT NULL,
	"appealable_until" timestamp with time zone NOT NULL,
	"interim" boolean DEFAULT true NOT NULL,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_decision_target_type_chk" CHECK ("moderation_decision"."target_type" in ('problem','contribution')),
	CONSTRAINT "moderation_decision_outcome_chk" CHECK ("moderation_decision"."outcome" in ('published','needs_revision','rejected')),
	CONSTRAINT "moderation_decision_rule_ids_chk" CHECK (cardinality("moderation_decision"."rule_ids") > 0),
	CONSTRAINT "moderation_decision_span_chk" CHECK (("moderation_decision"."span_start" is null and "moderation_decision"."span_end" is null) or ("moderation_decision"."span_start" is not null and "moderation_decision"."span_end" is not null and "moderation_decision"."span_start" < "moderation_decision"."span_end")),
	CONSTRAINT "moderation_decision_explain_chk" CHECK ("moderation_decision"."outcome" = 'published' or ("moderation_decision"."field_ref" is not null and ("moderation_decision"."revision_hint" is not null or "moderation_decision"."safety_sensitive")))
);
--> statement-breakpoint
CREATE INDEX "moderation_decision_target_idx" ON "moderation_decision" USING btree ("target_type","target_id");--> statement-breakpoint
REVOKE UPDATE, DELETE ON moderation_decision FROM can_app_rw;
