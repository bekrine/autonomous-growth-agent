CREATE TABLE "analytics_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"insight_type" text NOT NULL,
	"dimension" text,
	"dimension_value" text,
	"finding" text NOT NULL,
	"evidence" jsonb,
	"confidence" numeric,
	"sample_size" numeric,
	"time_range_start" timestamp with time zone,
	"time_range_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"metric_name" text NOT NULL,
	"platform_metric_name" text,
	"metric_value" numeric,
	"metric_unit" text DEFAULT 'count' NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"unavailable_reason" text,
	"source" text DEFAULT 'platform' NOT NULL,
	"computation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_metrics_snapshot_metric_key" UNIQUE("snapshot_id","metric_name")
);
--> statement-breakpoint
CREATE TABLE "content_analytics_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_post_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"external_post_id" text,
	"platform" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"published_at" timestamp with time zone,
	"last_snapshot_at" timestamp with time zone,
	"next_snapshot_at" timestamp with time zone,
	"completed_windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" numeric DEFAULT '0' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_analytics_state_content_post_id_unique" UNIQUE("content_post_id")
);
--> statement-breakpoint
ALTER TABLE "content_posts" ADD COLUMN "experiment_id" uuid;--> statement-breakpoint
ALTER TABLE "content_posts" ADD COLUMN "experiment_variant_id" uuid;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "content_generation_id" uuid;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "social_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "external_post_id" text;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "collection_window" text;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD COLUMN "error_reason" text;--> statement-breakpoint
ALTER TABLE "analytics_insights" ADD CONSTRAINT "analytics_insights_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_metrics" ADD CONSTRAINT "analytics_metrics_snapshot_id_analytics_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."analytics_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_analytics_state" ADD CONSTRAINT "content_analytics_state_content_post_id_content_posts_id_fk" FOREIGN KEY ("content_post_id") REFERENCES "public"."content_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_analytics_state" ADD CONSTRAINT "content_analytics_state_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_insights_social_account_id_idx" ON "analytics_insights" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "analytics_insights_type_idx" ON "analytics_insights" USING btree ("insight_type");--> statement-breakpoint
CREATE INDEX "analytics_metrics_snapshot_id_idx" ON "analytics_metrics" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "analytics_metrics_name_idx" ON "analytics_metrics" USING btree ("metric_name");--> statement-breakpoint
CREATE INDEX "content_analytics_state_status_idx" ON "content_analytics_state" USING btree ("status");--> statement-breakpoint
CREATE INDEX "content_analytics_state_next_snapshot_idx" ON "content_analytics_state" USING btree ("next_snapshot_at");--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_idempotency_key" UNIQUE("social_account_id","content_post_id","metric_type","collection_window");