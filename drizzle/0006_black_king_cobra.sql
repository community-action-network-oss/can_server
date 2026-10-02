ALTER TABLE "problem" ADD COLUMN "intake_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "no_evidence_note" text;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "identifiers_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "review_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "deleted_at" timestamp with time zone;