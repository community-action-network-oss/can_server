CREATE TABLE "account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email_ciphertext" "bytea" NOT NULL,
	"email_hmac" "bytea" NOT NULL,
	"handle" text NOT NULL,
	"handle_regenerations" integer DEFAULT 0 NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"volunteer_reviewer" boolean DEFAULT false NOT NULL,
	"volunteer_reviewer_since" timestamp with time zone,
	"age_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"origin_node_id" text NOT NULL,
	"protocol_version" text NOT NULL,
	CONSTRAINT "account_email_hmac_unique" UNIQUE("email_hmac"),
	CONSTRAINT "account_handle_unique" UNIQUE("handle"),
	CONSTRAINT "account_role_chk" CHECK ("account"."role" in ('member','moderator','admin'))
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"detail" jsonb NOT NULL,
	"transitional" boolean DEFAULT false NOT NULL,
	"ip_class" text,
	"at" timestamp with time zone NOT NULL,
	"origin_node_id" text NOT NULL,
	"protocol_version" text NOT NULL,
	"prev_hash" text
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"issued_by" uuid NOT NULL,
	"redeemed_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	CONSTRAINT "invite_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "jurisdiction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"is_fictional" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"emergency_notice" text,
	"rule_set_version" text,
	"origin_node_id" text NOT NULL,
	"protocol_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_code" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"client_kind" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "session_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "session_client_kind_chk" CHECK ("session"."client_kind" in ('web','native'))
);
--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_issued_by_account_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_redeemed_by_account_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_code" ADD CONSTRAINT "login_code_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;