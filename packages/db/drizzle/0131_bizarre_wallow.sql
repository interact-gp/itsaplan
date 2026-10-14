CREATE TABLE "slack_reminder_delivery" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_reminder_delivery_trigger_check" CHECK ("slack_reminder_delivery"."trigger" IN ('schedule', 'manual')),
	CONSTRAINT "slack_reminder_delivery_status_check" CHECK ("slack_reminder_delivery"."status" IN ('pending', 'sent', 'skipped', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "project_document" ADD COLUMN "personal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "slack_reminders" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_reminder_delivery" ADD CONSTRAINT "slack_reminder_delivery_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_reminder_delivery_occurrence_uq" ON "slack_reminder_delivery" USING btree ("user_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "slack_reminder_delivery_due_idx" ON "slack_reminder_delivery" USING btree ("next_attempt_at") WHERE "slack_reminder_delivery"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "project_document_personal_owner_uq" ON "project_document" USING btree ("owner_user_id") WHERE "project_document"."personal";--> statement-breakpoint
ALTER TABLE "project_document" ADD CONSTRAINT "project_document_personal_private_check" CHECK (NOT "project_document"."personal" OR "project_document"."is_private");