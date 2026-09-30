CREATE TABLE "pat_repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"url" text NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"script" text DEFAULT 'test' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_repositories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_repository_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"request_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"job" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_repository_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_repositories" ADD CONSTRAINT "pat_repositories_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_repository_runs" ADD CONSTRAINT "pat_repository_runs_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_repository_runs" ADD CONSTRAINT "pat_repository_runs_repository_id_pat_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."pat_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pat_repository_url_idx" ON "pat_repositories" USING btree ("workspace_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_repository_request_idx" ON "pat_repository_runs" USING btree ("workspace_id","request_id");