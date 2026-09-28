CREATE TABLE "pat_workspace_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"item_id" text NOT NULL,
	"item_version" integer NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"url" text,
	"target_item_id" text,
	"target_version" integer,
	"thread_id" text,
	"observed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_workspace_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_workspace_evidence" ADD CONSTRAINT "pat_workspace_evidence_workspace_id_pat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."pat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_workspace_evidence" ADD CONSTRAINT "pat_workspace_evidence_item_id_pat_workspace_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."pat_workspace_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_workspace_evidence" ADD CONSTRAINT "pat_workspace_evidence_target_item_id_pat_workspace_items_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "public"."pat_workspace_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_workspace_evidence" ADD CONSTRAINT "pat_workspace_evidence_thread_id_pat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."pat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pat_workspace_evidence_item_idx" ON "pat_workspace_evidence" USING btree ("item_id");