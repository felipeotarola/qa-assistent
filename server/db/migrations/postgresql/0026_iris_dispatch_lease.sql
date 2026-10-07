ALTER TABLE "pat_browser_jobs" ADD COLUMN "dispatch_lease_token" text;--> statement-breakpoint
ALTER TABLE "pat_browser_jobs" ADD COLUMN "dispatch_lease_until" timestamp with time zone;