CREATE TABLE "slack_bot_message" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"kind" text NOT NULL,
	"issue_id" integer NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_bot_message_kind_check" CHECK ("slack_bot_message"."kind" IN ('thread_reply', 'private_reply', 'assignee')),
	CONSTRAINT "slack_bot_message_status_check" CHECK ("slack_bot_message"."status" IN ('pending', 'sent', 'skipped', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "slack_event" ADD COLUMN "bot_user_id" text;--> statement-breakpoint
ALTER TABLE "slack_event" ADD COLUMN "issue_description" text;--> statement-breakpoint
ALTER TABLE "slack_event" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_event" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_event" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_bot_message" ADD CONSTRAINT "slack_bot_message_event_id_slack_event_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."slack_event"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_bot_message" ADD CONSTRAINT "slack_bot_message_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_bot_message" ADD CONSTRAINT "slack_bot_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_bot_message_event_kind_uq" ON "slack_bot_message" USING btree ("event_id","kind");--> statement-breakpoint
CREATE INDEX "slack_bot_message_due_idx" ON "slack_bot_message" USING btree ("next_attempt_at") WHERE "slack_bot_message"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "slack_event_retry_idx" ON "slack_event" USING btree ("next_attempt_at") WHERE "slack_event"."status" IN ('received', 'failed');