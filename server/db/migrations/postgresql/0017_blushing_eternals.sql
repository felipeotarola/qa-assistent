CREATE TABLE "pat_project_environments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repo_url" text NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"sealed_values" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_project_environments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_setup_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"runtime" text NOT NULL,
	"parent_session_id" text NOT NULL,
	"session_key" text NOT NULL,
	"task" text NOT NULL,
	"model" text NOT NULL,
	"reasoning" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"result" jsonb,
	"notification" text DEFAULT 'pending' NOT NULL,
	"notified_version" text,
	"apply_revision" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_setup_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_project_environments" ADD CONSTRAINT "pat_project_environments_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_setup_jobs" ADD CONSTRAINT "pat_setup_jobs_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_setup_jobs" ADD CONSTRAINT "pat_setup_jobs_thread_id_pat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."pat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pat_project_environment_scope" ON "pat_project_environments" USING btree ("workspace_id","repo_url","environment");