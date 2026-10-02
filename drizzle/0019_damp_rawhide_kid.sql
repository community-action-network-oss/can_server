CREATE TABLE "pseudonym_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '1 hour' NOT NULL,
	CONSTRAINT "pseudonym_token_op_token_uq" UNIQUE("operation_id","token")
);
--> statement-breakpoint
CREATE INDEX "pseudonym_token_expires_idx" ON "pseudonym_token" USING btree ("expires_at");
--> statement-breakpoint
CREATE FUNCTION pseudonym_token_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pseudonym_token rows are immutable; delete to purge';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pseudonym_token_no_update BEFORE UPDATE ON pseudonym_token FOR EACH ROW EXECUTE FUNCTION pseudonym_token_no_update();
