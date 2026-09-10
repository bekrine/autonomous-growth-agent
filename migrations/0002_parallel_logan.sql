CREATE TYPE "public"."content_generation_status" AS ENUM('generating', 'generated', 'generation_failed');--> statement-breakpoint
CREATE TYPE "public"."media_asset_status" AS ENUM('requested', 'generating', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."media_asset_type" AS ENUM('image', 'video');--> statement-breakpoint
ALTER TYPE "public"."content_post_status" ADD VALUE 'idea';--> statement-breakpoint
ALTER TYPE "public"."content_post_status" ADD VALUE 'brief_created';--> statement-breakpoint
ALTER TYPE "public"."content_post_status" ADD VALUE 'generating';--> statement-breakpoint
ALTER TYPE "public"."content_post_status" ADD VALUE 'generated';--> statement-breakpoint
ALTER TYPE "public"."content_post_status" ADD VALUE 'reviewing';--> statement-breakpoint
ALTER TYPE "public"."content_post_status" ADD VALUE 'ready_for_publishing';--> statement-breakpoint
ALTER TYPE "public"."content_post_status" ADD VALUE 'generation_failed';--> statement-breakpoint
ALTER TYPE "public"."content_post_status" ADD VALUE 'review_failed';--> statement-breakpoint
CREATE TABLE "content_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_generation_id" uuid NOT NULL,
	"asset_type" "media_asset_type" NOT NULL,
	"storage_key" text,
	"url" text,
	"mime_type" text,
	"provider" text NOT NULL,
	"provider_asset_id" text,
	"width" integer,
	"height" integer,
	"duration_seconds" numeric,
	"status" "media_asset_status" DEFAULT 'requested' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_post_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"attempt_number" integer NOT NULL,
	"format" text NOT NULL,
	"payload" jsonb,
	"status" "content_generation_status" DEFAULT 'generating' NOT NULL,
	"error_message" text,
	"agent_run_id" uuid,
	"llm_provider" text,
	"llm_model" text,
	"duration_ms" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_generations_post_id_version_key" UNIQUE("content_post_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "content_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_generation_id" uuid NOT NULL,
	"approved" boolean NOT NULL,
	"score" numeric NOT NULL,
	"quality_score" numeric NOT NULL,
	"brand_score" numeric NOT NULL,
	"safety_score" numeric NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_reviews_content_generation_id_unique" UNIQUE("content_generation_id")
);
--> statement-breakpoint
ALTER TABLE "content_posts" ADD COLUMN "current_generation_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_posts" ADD COLUMN "generation_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_content_generation_id_content_generations_id_fk" FOREIGN KEY ("content_generation_id") REFERENCES "public"."content_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_generations" ADD CONSTRAINT "content_generations_content_post_id_content_posts_id_fk" FOREIGN KEY ("content_post_id") REFERENCES "public"."content_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_generations" ADD CONSTRAINT "content_generations_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_content_generation_id_content_generations_id_fk" FOREIGN KEY ("content_generation_id") REFERENCES "public"."content_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_assets_content_generation_id_idx" ON "content_assets" USING btree ("content_generation_id");--> statement-breakpoint
CREATE INDEX "content_generations_content_post_id_idx" ON "content_generations" USING btree ("content_post_id");--> statement-breakpoint
CREATE INDEX "content_reviews_content_generation_id_idx" ON "content_reviews" USING btree ("content_generation_id");--> statement-breakpoint
ALTER TABLE "content_posts" ADD CONSTRAINT "content_posts_content_idea_id_unique" UNIQUE("content_idea_id");