CREATE TABLE "pat_test_captures" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"item_id" text,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"action" text NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_test_captures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_test_captures" ADD CONSTRAINT "pat_test_captures_run_id_pat_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pat_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_test_captures" ADD CONSTRAINT "pat_test_captures_item_id_pat_workspace_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."pat_workspace_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pat_test_capture_run_idx" ON "pat_test_captures" USING btree ("run_id","created_at");