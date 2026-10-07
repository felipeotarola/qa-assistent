CREATE TABLE "pat_provider_pacing" (
	"bucket_hash" text PRIMARY KEY NOT NULL,
	"next_start_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_provider_pacing" ENABLE ROW LEVEL SECURITY;
