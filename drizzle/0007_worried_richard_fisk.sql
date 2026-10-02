CREATE TABLE "content_schema_version" (
	"type" text NOT NULL,
	"version" text NOT NULL,
	"pack_version" text NOT NULL,
	"schema_hash" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "content_schema_version_type_schema_hash_pk" PRIMARY KEY("type","schema_hash")
);
--> statement-breakpoint
ALTER TABLE "problem" ADD COLUMN "content" jsonb;