CREATE TABLE "learning_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"outcome" text NOT NULL,
	"evidence_strength" text,
	"dry_run" boolean DEFAULT true NOT NULL,
	"blocked_reason" text,
	"proposal" jsonb,
	"evaluation" jsonb,
	"evidence" jsonb,
	"applied_strategy_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "parent_version_id" uuid;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "change_summary" text;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "evidence_strength" text;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "change_source" text;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "learning_run_id" uuid;--> statement-breakpoint
ALTER TABLE "learning_runs" ADD CONSTRAINT "learning_runs_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_runs" ADD CONSTRAINT "learning_runs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_runs_social_account_id_idx" ON "learning_runs" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "learning_runs_created_at_idx" ON "learning_runs" USING btree ("created_at");