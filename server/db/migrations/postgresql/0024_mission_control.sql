-- New control fields stay NULL on historical missions/tasks. No legacy adoption.
-- Lease/deadline columns use timestamptz; physical resource uniqueness is shared
-- across runtimes and tenants using the same server-issued pool key.
CREATE TABLE "pat_environment_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"runtime" text NOT NULL,
	"request_id" text NOT NULL,
	"grant_setup_job_id" text NOT NULL,
	"repo_url" text NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"plan_hash" text NOT NULL,
	"plan" jsonb NOT NULL,
	"allowed_names" jsonb NOT NULL,
	"vault_revision" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_environment_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_mission_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"task_id" text NOT NULL,
	"runtime" text NOT NULL,
	"kind" text NOT NULL,
	"operation_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"dispatch_id" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"supplement_round" integer DEFAULT 0 NOT NULL,
	"mandate_revision" integer NOT NULL,
	"plan_revision" integer NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_tokens" integer NOT NULL,
	"reserved_tool_calls" integer NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"tool_call_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage" jsonb,
	"receipt" jsonb,
	"executor_resource_id" text,
	"error" text,
	"cancel_requested_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"fence" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pat_mission_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_mission_resource_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"pool_key" text NOT NULL,
	"resource_key" text NOT NULL,
	"workspace_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"runtime" text NOT NULL,
	"owner" text DEFAULT 'agent' NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"executor_resource_id" text,
	"lease_token" text NOT NULL,
	"fence" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_mission_resource_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_mission_waits" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"wait_key" text NOT NULL,
	"definition" jsonb NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"answer" jsonb,
	"answer_request_id" text,
	"deadline_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_mission_waits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_mission_events" ADD COLUMN "event_key" text;--> statement-breakpoint
ALTER TABLE "pat_mission_tasks" ADD COLUMN "spec" jsonb;--> statement-breakpoint
ALTER TABLE "pat_mission_tasks" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "pat_mission_tasks" ADD COLUMN "operation_id" text;--> statement-breakpoint
ALTER TABLE "pat_mission_tasks" ADD COLUMN "dependency_requirements" jsonb;--> statement-breakpoint
ALTER TABLE "pat_mission_tasks" ADD COLUMN "supplement_round" integer;--> statement-breakpoint
ALTER TABLE "pat_mission_tasks" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "pat_mission_tasks" ADD COLUMN "plan_revision" integer;--> statement-breakpoint
ALTER TABLE "pat_mission_tasks" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "controller_version" integer;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "admission" jsonb;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "intent" text;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "mandate" jsonb;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "plan_revision" integer;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "mandate_revision" integer;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "lifecycle" text;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "closure_reason" text;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "report_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "fence" integer;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "next_wake_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pat_environment_consents" ADD CONSTRAINT "pat_environment_consents_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The referenced composite identity must exist before its foreign key.
CREATE UNIQUE INDEX "pat_mission_task_identity" ON "pat_mission_tasks" USING btree ("mission_id","id");--> statement-breakpoint
ALTER TABLE "pat_mission_attempts" ADD CONSTRAINT "pat_mission_attempts_mission_id_pat_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."pat_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_mission_attempts" ADD CONSTRAINT "pat_mission_attempt_task_fk" FOREIGN KEY ("mission_id","task_id") REFERENCES "public"."pat_mission_tasks"("mission_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_mission_resource_claims" ADD CONSTRAINT "pat_mission_resource_claims_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_mission_resource_claims" ADD CONSTRAINT "pat_mission_resource_claims_mission_id_pat_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."pat_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_mission_resource_claims" ADD CONSTRAINT "pat_mission_resource_claims_attempt_id_pat_mission_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."pat_mission_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_mission_waits" ADD CONSTRAINT "pat_mission_waits_mission_id_pat_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."pat_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pat_environment_consent_request" ON "pat_environment_consents" USING btree ("workspace_id","runtime","request_id");--> statement-breakpoint
CREATE INDEX "pat_environment_consent_plan" ON "pat_environment_consents" USING btree ("workspace_id","runtime","repo_url","plan_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_mission_attempt_dispatch" ON "pat_mission_attempts" USING btree ("dispatch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_mission_attempt_operation" ON "pat_mission_attempts" USING btree ("mission_id","operation_id","attempt_no");--> statement-breakpoint
CREATE INDEX "pat_mission_attempt_active" ON "pat_mission_attempts" USING btree ("runtime","status","deadline_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_mission_resource_exclusive" ON "pat_mission_resource_claims" USING btree ("pool_key","resource_key");--> statement-breakpoint
CREATE INDEX "pat_mission_resource_attempt" ON "pat_mission_resource_claims" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_mission_wait_identity" ON "pat_mission_waits" USING btree ("mission_id","wait_key");--> statement-breakpoint
CREATE INDEX "pat_mission_wait_deadline" ON "pat_mission_waits" USING btree ("state","deadline_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_mission_event_key" ON "pat_mission_events" USING btree ("mission_id","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_mission_task_operation" ON "pat_mission_tasks" USING btree ("mission_id","operation_id");--> statement-breakpoint
CREATE INDEX "pat_mission_control_queue" ON "pat_missions" USING btree ("runtime","controller_version","lifecycle","next_wake_at");
