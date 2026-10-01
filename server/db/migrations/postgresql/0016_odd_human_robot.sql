CREATE TABLE "pat_workspace_quality" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_workspace_quality" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_test_runs" ADD COLUMN "target" jsonb;--> statement-breakpoint
ALTER TABLE "pat_workspace_quality" ADD CONSTRAINT "pat_workspace_quality_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;