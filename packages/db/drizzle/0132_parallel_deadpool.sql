CREATE TABLE "issue_participant" (
	"issue_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"added_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_participant_issue_id_user_id_pk" PRIMARY KEY("issue_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "slack_request_message" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"issue_id" integer NOT NULL,
	"kind" text NOT NULL,
	"actor_name" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_request_message_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "slack_request_message_kind_check" CHECK ("slack_request_message"."kind" IN ('assigned', 'added', 'removed', 'mentioned', 'commented', 'state_changed')),
	CONSTRAINT "slack_request_message_status_check" CHECK ("slack_request_message"."status" IN ('pending', 'sent', 'skipped', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "participant_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_participant" ADD CONSTRAINT "issue_participant_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_participant" ADD CONSTRAINT "issue_participant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_participant" ADD CONSTRAINT "issue_participant_added_by_user_id_user_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_request_message" ADD CONSTRAINT "slack_request_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_request_message" ADD CONSTRAINT "slack_request_message_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_participant_user_idx" ON "issue_participant" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "slack_request_message_due_idx" ON "slack_request_message" USING btree ("next_attempt_at") WHERE "slack_request_message"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;