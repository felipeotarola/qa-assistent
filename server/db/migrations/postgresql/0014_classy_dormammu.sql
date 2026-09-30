CREATE TABLE "pat_browser_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"agent_id" text DEFAULT 'main' NOT NULL,
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
ALTER TABLE "pat_browser_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_browser_assignments" ADD CONSTRAINT "pat_browser_assignments_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_browser_assignments" ADD CONSTRAINT "pat_browser_assignments_user_id_pat_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pat_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pat_browser_assignment_scope" ON "pat_browser_assignments" USING btree ("workspace_id","thread_id","agent_id");