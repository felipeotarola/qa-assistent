CREATE TABLE "pat_test_requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"item_id" text NOT NULL,
	"case_id" text NOT NULL,
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"question" text NOT NULL,
	"clarification" text NOT NULL,
	"expected" text NOT NULL,
	"plan_version" integer NOT NULL,
	"source_item_id" text,
	"source_version" integer,
	"issue" jsonb,
	"destination" jsonb,
	"prepared_body" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"published_at" timestamp,
	"applied_version" integer,
	"material_id" text
);
--> statement-breakpoint
ALTER TABLE "pat_test_requirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_test_run_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_test_run_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_test_requirements" ADD CONSTRAINT "pat_test_requirements_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_test_requirements" ADD CONSTRAINT "pat_test_requirements_item_id_pat_workspace_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."pat_workspace_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_test_run_reviews" ADD CONSTRAINT "pat_test_run_reviews_run_id_pat_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pat_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pat_requirement_request_idx" ON "pat_test_requirements" USING btree ("workspace_id","request_id");--> statement-breakpoint
CREATE INDEX "pat_requirement_case_idx" ON "pat_test_requirements" USING btree ("item_id","case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_run_review_request_idx" ON "pat_test_run_reviews" USING btree ("run_id","request_id");--> statement-breakpoint
CREATE INDEX "pat_run_review_idx" ON "pat_test_run_reviews" USING btree ("run_id","created_at");