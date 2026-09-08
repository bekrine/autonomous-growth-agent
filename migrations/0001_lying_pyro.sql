CREATE TABLE "research_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"relevance_score" numeric NOT NULL,
	"audience_interest_score" numeric NOT NULL,
	"competition_score" numeric NOT NULL,
	"rationale" text,
	"source_type" text DEFAULT 'mock' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "content_ideas" ADD COLUMN "agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "content_ideas" ADD COLUMN "format" text;--> statement-breakpoint
ALTER TABLE "content_ideas" ADD COLUMN "content_pillar" text;--> statement-breakpoint
ALTER TABLE "content_ideas" ADD COLUMN "target_audience" text;--> statement-breakpoint
ALTER TABLE "content_ideas" ADD COLUMN "hook" text;--> statement-breakpoint
ALTER TABLE "content_ideas" ADD COLUMN "objective" text;--> statement-breakpoint
ALTER TABLE "content_ideas" ADD COLUMN "priority_score" numeric;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_findings_social_account_id_idx" ON "research_findings" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "research_findings_agent_run_id_idx" ON "research_findings" USING btree ("agent_run_id");--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_ideas" ADD CONSTRAINT "content_ideas_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strategy_versions_agent_run_id_idx" ON "strategy_versions" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "content_ideas_agent_run_id_idx" ON "content_ideas" USING btree ("agent_run_id");