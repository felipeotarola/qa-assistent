CREATE TABLE "pat_test_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"item_id" text NOT NULL,
	"case_id" text NOT NULL,
	"plan_version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"environment" text NOT NULL,
	"thread_id" text NOT NULL,
	"request_id" text NOT NULL,
	"result" jsonb,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "pat_test_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_test_runs" ADD CONSTRAINT "pat_test_runs_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_test_runs" ADD CONSTRAINT "pat_test_runs_item_id_pat_workspace_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."pat_workspace_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pat_run_request_idx" ON "pat_test_runs" USING btree ("workspace_id","request_id");--> statement-breakpoint
CREATE INDEX "pat_run_case_idx" ON "pat_test_runs" USING btree ("item_id","case_id","started_at");