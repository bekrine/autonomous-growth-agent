CREATE TYPE "public"."social_account_type" AS ENUM('business', 'creator', 'personal', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."social_connection_status" AS ENUM('connected', 'expired', 'revoked', 'error');--> statement-breakpoint
ALTER TYPE "public"."content_post_status" ADD VALUE 'queued';--> statement-breakpoint
ALTER TYPE "public"."content_post_status" ADD VALUE 'publishing';--> statement-breakpoint
ALTER TYPE "public"."content_post_status" ADD VALUE 'publish_failed';--> statement-breakpoint
ALTER TYPE "public"."publishing_job_status" ADD VALUE 'scheduled';--> statement-breakpoint
ALTER TYPE "public"."publishing_job_status" ADD VALUE 'publishing';--> statement-breakpoint
ALTER TYPE "public"."publishing_job_status" ADD VALUE 'published';--> statement-breakpoint
ALTER TYPE "public"."publishing_job_status" ADD VALUE 'retry_scheduled';--> statement-breakpoint
ALTER TYPE "public"."publishing_job_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL,
	"platform" "social_platform" NOT NULL,
	"social_account_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "social_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"platform" "social_platform" NOT NULL,
	"platform_account_id" text NOT NULL,
	"platform_username" text,
	"account_type" "social_account_type" DEFAULT 'unknown' NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "social_connection_status" DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_connections_platform_account_key" UNIQUE("platform","platform_account_id")
);
--> statement-breakpoint
ALTER TABLE "publishing_jobs" ADD COLUMN "content_generation_id" uuid;--> statement-breakpoint
ALTER TABLE "publishing_jobs" ADD COLUMN "social_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "publishing_jobs" ADD COLUMN "platform" "social_platform";--> statement-breakpoint
ALTER TABLE "publishing_jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "publishing_jobs" ADD COLUMN "external_container_id" text;--> statement-breakpoint
ALTER TABLE "publishing_jobs" ADD COLUMN "external_post_id" text;--> statement-breakpoint
ALTER TABLE "publishing_jobs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "publishing_jobs" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "social_connections_social_account_id_idx" ON "social_connections" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "social_connections_status_idx" ON "social_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "publishing_jobs_scheduled_for_idx" ON "publishing_jobs" USING btree ("scheduled_for");--> statement-breakpoint
ALTER TABLE "publishing_jobs" ADD CONSTRAINT "publishing_jobs_idempotency_key_key" UNIQUE("idempotency_key");