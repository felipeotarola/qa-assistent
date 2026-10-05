CREATE TABLE "pat_mission_events" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_mission_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_mission_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'Sammanställer underlag' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"error" text,
	"model" text,
	"document" jsonb,
	"read_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"item_id" text,
	"notification" text DEFAULT 'pending' NOT NULL,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_mission_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_mission_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"revision" integer NOT NULL,
	"hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_mission_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_mission_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"request_id" text NOT NULL,
	"title" text NOT NULL,
	"actor" text NOT NULL,
	"parent_id" text,
	"criterion_ids" jsonb NOT NULL,
	"depends_on" jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_mission_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_missions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"runtime" text NOT NULL,
	"request_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"dirty_since" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_missions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_report_share_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_report_share_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_report_share_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_report_share_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_report_share_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"share_id" text NOT NULL,
	"revision" integer NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_report_share_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_report_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"token" text NOT NULL,
	"mode" text NOT NULL,
	"pin_hash" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"evidence_ids" jsonb NOT NULL,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_report_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_mission_events" ADD CONSTRAINT "pat_mission_events_mission_id_pat_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."pat_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_mission_reports" ADD CONSTRAINT "pat_mission_reports_mission_id_pat_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."pat_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_mission_reports" ADD CONSTRAINT "pat_mission_reports_snapshot_id_pat_mission_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."pat_mission_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_mission_reports" ADD CONSTRAINT "pat_mission_reports_item_id_pat_workspace_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."pat_workspace_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_mission_snapshots" ADD CONSTRAINT "pat_mission_snapshots_mission_id_pat_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."pat_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_mission_tasks" ADD CONSTRAINT "pat_mission_tasks_mission_id_pat_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."pat_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD CONSTRAINT "pat_missions_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_report_share_audit" ADD CONSTRAINT "pat_report_share_audit_report_id_pat_mission_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."pat_mission_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_report_share_sessions" ADD CONSTRAINT "pat_report_share_sessions_share_id_pat_report_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."pat_report_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_report_shares" ADD CONSTRAINT "pat_report_shares_report_id_pat_mission_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."pat_mission_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pat_mission_event_revision" ON "pat_mission_events" USING btree ("mission_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_mission_report_snapshot" ON "pat_mission_reports" USING btree ("snapshot_id","version");--> statement-breakpoint
CREATE INDEX "pat_mission_report_queue" ON "pat_mission_reports" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_mission_snapshot_revision" ON "pat_mission_snapshots" USING btree ("mission_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_mission_task_request" ON "pat_mission_tasks" USING btree ("mission_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_mission_request" ON "pat_missions" USING btree ("workspace_id","runtime","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_report_share_token" ON "pat_report_shares" USING btree ("token");--> statement-breakpoint
CREATE INDEX "pat_report_share_report" ON "pat_report_shares" USING btree ("report_id");