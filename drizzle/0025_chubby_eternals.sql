CREATE TABLE "consent_record" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "follow" (
	"account_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"muted_at" timestamp with time zone,
	"mail_consent_at" timestamp with time zone,
	CONSTRAINT "follow_account_id_problem_id_pk" PRIMARY KEY("account_id","problem_id")
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"event_id" uuid NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notification_account_event_uq" UNIQUE("account_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow" ADD CONSTRAINT "follow_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow" ADD CONSTRAINT "follow_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_record_account_idx" ON "consent_record" USING btree ("account_id","purpose");--> statement-breakpoint
CREATE INDEX "notification_account_idx" ON "notification" USING btree ("account_id","created_at","id");