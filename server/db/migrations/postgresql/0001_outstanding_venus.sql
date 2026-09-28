CREATE TABLE "pat_browser_sessions" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"context_id" text,
	"session_id" text,
	"project_id" text,
	"connect_url" text,
	"live_url" text,
	"control" text DEFAULT 'agent' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"expires_at" timestamp,
	"active_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_browser_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "pat_browser_sessions" ADD CONSTRAINT "pat_browser_sessions_thread_id_pat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."pat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_browser_sessions" ADD CONSTRAINT "pat_browser_sessions_user_id_pat_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pat_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

