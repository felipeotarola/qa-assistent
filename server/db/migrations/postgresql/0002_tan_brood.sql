CREATE TABLE "pat_workspace_browsers" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
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
ALTER TABLE "pat_workspace_browsers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_workspace_item_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_workspace_item_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_workspace_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb NOT NULL,
	"blob_path" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_workspace_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "pat_threads" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "pat_workspace_browsers" ADD CONSTRAINT "pat_workspace_browsers_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_workspace_browsers" ADD CONSTRAINT "pat_workspace_browsers_user_id_pat_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pat_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_workspace_item_versions" ADD CONSTRAINT "pat_workspace_item_versions_item_id_pat_workspace_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."pat_workspace_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_workspace_items" ADD CONSTRAINT "pat_workspace_items_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_workspaces" ADD CONSTRAINT "pat_workspaces_user_id_pat_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pat_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pat_item_version_idx" ON "pat_workspace_item_versions" USING btree ("item_id","version");--> statement-breakpoint
ALTER TABLE "pat_threads" ADD CONSTRAINT "pat_threads_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

--> statement-breakpoint
INSERT INTO pat_workspaces (id, user_id, name)
SELECT gen_random_uuid()::text, id, 'Mitt workspace' FROM pat_user;
--> statement-breakpoint
UPDATE pat_threads t SET workspace_id = w.id FROM pat_workspaces w WHERE w.user_id = t.user_id AND t.workspace_id IS NULL;
--> statement-breakpoint
INSERT INTO pat_workspace_browsers (workspace_id, user_id, context_id, session_id, project_id, connect_url, live_url, control, url, title, expires_at, active_at)
SELECT DISTINCT ON (t.workspace_id) t.workspace_id, b.user_id, b.context_id, b.session_id, b.project_id, b.connect_url, b.live_url, b.control, b.url, b.title, b.expires_at, b.active_at
FROM pat_browser_sessions b JOIN pat_threads t ON t.id = b.thread_id WHERE t.workspace_id IS NOT NULL ORDER BY t.workspace_id, b.active_at DESC;
