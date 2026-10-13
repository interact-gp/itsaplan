CREATE TABLE "slack_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"slack_team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_ts" text NOT NULL,
	"thread_ts" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" text,
	"request" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"issue_id" integer,
	"project_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_event_status_check" CHECK ("slack_event"."status" IN ('received', 'clarify', 'done', 'refused', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "user_slack_account" (
	"slack_team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_slack_account_slack_team_id_slack_user_id_pk" PRIMARY KEY("slack_team_id","slack_user_id")
);
--> statement-breakpoint
ALTER TABLE "slack_event" ADD CONSTRAINT "slack_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_event" ADD CONSTRAINT "slack_event_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_event" ADD CONSTRAINT "slack_event_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_slack_account" ADD CONSTRAINT "user_slack_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_event_thread_idx" ON "slack_event" USING btree ("channel_id","thread_ts");--> statement-breakpoint
CREATE INDEX "user_slack_account_user_idx" ON "user_slack_account" USING btree ("user_id");