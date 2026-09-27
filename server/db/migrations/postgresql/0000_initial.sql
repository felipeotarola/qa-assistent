CREATE TABLE "pat_account" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pat_phone_links" (
	"app_user_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pat_phone_links_phone_number_pk" PRIMARY KEY("phone_number")
);
--> statement-breakpoint
CREATE TABLE "pat_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "pat_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "pat_slack_link_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"app_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pat_slack_links" (
	"app_user_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"slack_user_name" text,
	"slack_display_name" text,
	"slack_email" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pat_slack_links_slack_team_id_slack_user_id_pk" PRIMARY KEY("slack_team_id","slack_user_id")
);
--> statement-breakpoint
CREATE TABLE "pat_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"session_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pat_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pat_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "pat_user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pat_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pat_account" ADD CONSTRAINT "pat_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pat_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_session" ADD CONSTRAINT "pat_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pat_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_threads" ADD CONSTRAINT "pat_threads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pat_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_user_profiles" ADD CONSTRAINT "pat_user_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pat_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pat_account_issuer_accountId_uidx" ON "pat_account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "pat_account_userId_idx" ON "pat_account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_phone_links_app_user_idx" ON "pat_phone_links" USING btree ("app_user_id");--> statement-breakpoint
CREATE INDEX "pat_session_userId_idx" ON "pat_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pat_slack_link_codes_app_user_idx" ON "pat_slack_link_codes" USING btree ("app_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_slack_links_app_user_idx" ON "pat_slack_links" USING btree ("app_user_id");--> statement-breakpoint
CREATE INDEX "pat_threads_user_updated_idx" ON "pat_threads" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "pat_verification_identifier_idx" ON "pat_verification" USING btree ("identifier");
--> statement-breakpoint
ALTER TABLE "pat_account" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
ALTER TABLE "pat_phone_links" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
ALTER TABLE "pat_session" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
ALTER TABLE "pat_slack_link_codes" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
ALTER TABLE "pat_slack_links" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
ALTER TABLE "pat_threads" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
ALTER TABLE "pat_user" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
ALTER TABLE "pat_user_profiles" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
ALTER TABLE "pat_verification" ENABLE ROW LEVEL SECURITY;
