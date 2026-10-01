CREATE TABLE "pat_browser_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"runtime" text NOT NULL,
	"parent_session_id" text NOT NULL,
	"session_id" text,
	"task" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"report" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"reasoning" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_browser_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_browser_jobs" ADD CONSTRAINT "pat_browser_jobs_thread_id_pat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."pat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pat_browser_jobs_thread_idx" ON "pat_browser_jobs" USING btree ("thread_id");