CREATE TABLE "task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"stage_choice_id" uuid,
	"title" text NOT NULL,
	"description" jsonb NOT NULL,
	"schema_id" text,
	"schema_version" text,
	"schema_hash" text,
	"owner_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"dropped_reason" text,
	"verification_note" text,
	"verified_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"origin_node_id" text NOT NULL,
	"protocol_version" text NOT NULL,
	CONSTRAINT "task_status_chk" CHECK ("task"."status" in ('open','claimed','in_progress','done','dropped')),
	CONSTRAINT "task_dropped_reason_chk" CHECK ("task"."status" <> 'dropped' or "task"."dropped_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "task_blocker" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"text" text NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_stage_choice_id_stage_choice_id_fk" FOREIGN KEY ("stage_choice_id") REFERENCES "public"."stage_choice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_owner_id_account_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_verified_by_account_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocker" ADD CONSTRAINT "task_blocker_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocker" ADD CONSTRAINT "task_blocker_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_stage_idx" ON "task" USING btree ("stage_id","status");--> statement-breakpoint
CREATE INDEX "task_blocker_task_idx" ON "task_blocker" USING btree ("task_id");