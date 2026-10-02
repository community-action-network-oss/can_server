DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'can_app_rw') THEN
    CREATE ROLE can_app_rw NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO can_app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO can_app_rw;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON events, audit_event FROM can_app_rw;
--> statement-breakpoint
-- Later tables created by the owner get full rights. Each new append-only table
-- MUST add its own `REVOKE UPDATE, DELETE ON <table> FROM can_app_rw;` in its migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO can_app_rw;
