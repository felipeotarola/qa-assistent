-- Preserve old material as readable but unknown. Only trusted producers assign
-- provenance to new versions; no historical source labels are upgraded.
ALTER TABLE "pat_workspace_items" ADD COLUMN "provenance" jsonb;
--> statement-breakpoint
ALTER TABLE "pat_workspace_item_versions" ADD COLUMN "provenance" jsonb;
