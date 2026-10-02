ALTER TABLE "problem" ADD COLUMN "privacy_check_id" uuid;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "privacy_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "kept_flags" jsonb;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "repost_match" boolean;--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "submit_snapshot" jsonb;