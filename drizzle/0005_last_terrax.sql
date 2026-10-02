CREATE TABLE "draft_fingerprint" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hashes" text[] NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "draft_fingerprint_reason_chk" CHECK ("draft_fingerprint"."reason" in ('rejected','withdrawn'))
);
--> statement-breakpoint
CREATE INDEX "draft_fingerprint_expires_idx" ON "draft_fingerprint" USING btree ("expires_at");