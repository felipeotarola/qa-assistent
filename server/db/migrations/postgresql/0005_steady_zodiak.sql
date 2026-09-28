CREATE TABLE "pat_chat_events" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"session_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"emitted_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_chat_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_chat_runtimes" (
	"thread_id" text NOT NULL,
	"runtime" text NOT NULL,
	"session_id" text,
	CONSTRAINT "pat_chat_runtimes_thread_id_runtime_pk" PRIMARY KEY("thread_id","runtime")
);
--> statement-breakpoint
ALTER TABLE "pat_chat_runtimes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_chat_events" ADD CONSTRAINT "pat_chat_events_thread_id_pat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."pat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_chat_runtimes" ADD CONSTRAINT "pat_chat_runtimes_thread_id_pat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."pat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pat_chat_events_thread_idx" ON "pat_chat_events" USING btree ("thread_id","emitted_at");