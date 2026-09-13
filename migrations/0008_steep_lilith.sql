ALTER TYPE "public"."experiment_status" ADD VALUE 'ready';--> statement-breakpoint
ALTER TYPE "public"."experiment_status" ADD VALUE 'analyzing';--> statement-breakpoint
ALTER TYPE "public"."experiment_status" ADD VALUE 'paused';--> statement-breakpoint
ALTER TYPE "public"."experiment_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TYPE "public"."experiment_status" ADD VALUE 'failed';--> statement-breakpoint
ALTER TYPE "public"."experiment_status" ADD VALUE 'inconclusive';--> statement-breakpoint
CREATE TABLE "experiment_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"evaluation_key" text NOT NULL,
	"outcome" text NOT NULL,
	"primary_metric" text NOT NULL,
	"control_value" numeric,
	"variant_value" numeric,
	"relative_lift" numeric,
	"confidence" text,
	"sample_sizes" jsonb NOT NULL,
	"detail" jsonb,
	"conclusion" text,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiment_evaluations_key" UNIQUE("experiment_id","evaluation_key")
);
--> statement-breakpoint
ALTER TABLE "experiment_variants" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "experiment_variants" ADD COLUMN "variable_value" text;--> statement-breakpoint
ALTER TABLE "experiment_variants" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "experiment_variants" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "experiment_variants" ADD COLUMN "target_sample_size" integer;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "social_account_id" uuid;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "variable" text;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "primary_metric" text;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "secondary_metrics" jsonb;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "min_samples_per_variant" integer;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "observation_window_hours" integer;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "max_duration_days" integer;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "min_relative_lift" numeric;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "proposed_by_agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "experiment_evaluations" ADD CONSTRAINT "experiment_evaluations_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experiment_evaluations_experiment_id_idx" ON "experiment_evaluations" USING btree ("experiment_id");--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experiments_social_account_id_idx" ON "experiments" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "experiments_status_idx" ON "experiments" USING btree ("status");--> statement-breakpoint
ALTER TABLE "experiment_variants" ADD CONSTRAINT "experiment_variants_name_key" UNIQUE("experiment_id","name");