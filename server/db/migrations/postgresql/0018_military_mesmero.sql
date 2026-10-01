CREATE TABLE "pat_result_assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"runtime" text NOT NULL,
	"reviewer_version" text NOT NULL,
	"model" text NOT NULL,
	"source_hash" text NOT NULL,
	"input_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"assessment" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"notification" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "pat_result_assessments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_result_assessments" ADD CONSTRAINT "pat_result_assessments_run_id_pat_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pat_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_result_assessments" ADD CONSTRAINT "pat_result_assessments_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pat_result_assessment_input_idx" ON "pat_result_assessments" USING btree ("run_id","runtime","source_hash","reviewer_version");--> statement-breakpoint
CREATE INDEX "pat_result_assessment_queue_idx" ON "pat_result_assessments" USING btree ("runtime","status","next_attempt_at");