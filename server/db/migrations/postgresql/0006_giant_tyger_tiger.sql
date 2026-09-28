CREATE TABLE "pat_linear_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"credentials" text NOT NULL,
	"label" text NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_linear_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pat_linear_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"return_url" text NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_linear_oauth_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pat_linear_accounts" ADD CONSTRAINT "pat_linear_accounts_user_id_pat_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pat_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_linear_oauth_states" ADD CONSTRAINT "pat_linear_oauth_states_user_id_pat_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pat_user"("id") ON DELETE cascade ON UPDATE no action;