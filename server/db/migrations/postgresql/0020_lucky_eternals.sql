ALTER TABLE "pat_mission_reports" ADD COLUMN "read_receipts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pat_missions" ADD COLUMN "reconciled_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "pat_repository_runs" ADD COLUMN "runtime" text;--> statement-breakpoint
ALTER TABLE "pat_test_runs" ADD COLUMN "runtime" text;