CREATE TABLE "spend_alert" (
	"cap_key" text NOT NULL,
	"level" smallint NOT NULL,
	"day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_alert_pk" PRIMARY KEY("cap_key","level","day"),
	CONSTRAINT "spend_alert_level_chk" CHECK ("spend_alert"."level" in (50, 80, 100))
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"jurisdiction_id" uuid,
	"dp_id" text NOT NULL,
	"event_id" text,
	"run_id" uuid NOT NULL,
	"cost_micro_usd" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_ledger_cost_chk" CHECK ("spend_ledger"."cost_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE INDEX "spend_ledger_day_idx" ON "spend_ledger" USING btree ("day");--> statement-breakpoint
CREATE INDEX "spend_ledger_run_idx" ON "spend_ledger" USING btree ("run_id");--> statement-breakpoint
-- 09-u14: insert-only. The app role owns its tables, so a REVOKE alone does not bind it: the trigger does.
REVOKE UPDATE, DELETE, TRUNCATE ON spend_ledger, spend_alert FROM can_app_rw;
--> statement-breakpoint
CREATE FUNCTION spend_insert_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are insert-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER spend_ledger_insert_only BEFORE UPDATE OR DELETE ON spend_ledger FOR EACH ROW EXECUTE FUNCTION spend_insert_only();
--> statement-breakpoint
CREATE TRIGGER spend_alert_insert_only BEFORE UPDATE OR DELETE ON spend_alert FOR EACH ROW EXECUTE FUNCTION spend_insert_only();
