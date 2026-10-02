CREATE TABLE "problem" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"help_needed" jsonb NOT NULL,
	"origin_node_id" text NOT NULL,
	"protocol_version" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "problem_published_idx" ON "problem" USING btree ("published_at","id");