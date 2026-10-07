-- Execution ownership is recorded independently from reusable report sources.
-- Existing rows remain unbound; their historical attachments are preserved.
ALTER TABLE "pat_repository_runs" ADD COLUMN "mission_binding" jsonb;
--> statement-breakpoint
-- Null distinguishes unknown historical submissions from explicitly unbound v1.
ALTER TABLE "pat_repository_runs" ADD COLUMN "binding_version" integer;
