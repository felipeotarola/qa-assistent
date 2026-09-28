CREATE TABLE "pat_external_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"action" text NOT NULL,
	"fingerprint" text NOT NULL,
	"destination" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_external_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_workspace_destinations" (
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"destination" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_workspace_destinations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_external_operations" ADD CONSTRAINT "pat_external_operations_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_workspace_destinations" ADD CONSTRAINT "pat_workspace_destinations_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pat_workspace_destination_idx" ON "pat_workspace_destinations" USING btree ("workspace_id","provider");