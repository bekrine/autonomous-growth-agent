import { relations } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { socialAccounts } from "./core.js";
import { agentRuns } from "./runtime.js";

/**
 * One row per topic ResearchAgent surfaced during a run. `sourceType`
 * records where the signal came from ("mock" today; "web"/"trend"/etc.
 * once real ResearchProvider implementations exist) so simulated research
 * is never confused with real external data downstream.
 */
export const researchFindings = pgTable(
  "research_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    relevanceScore: numeric("relevance_score").notNull(),
    audienceInterestScore: numeric("audience_interest_score").notNull(),
    competitionScore: numeric("competition_score").notNull(),
    rationale: text("rationale"),
    sourceType: text("source_type").notNull().default("mock"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("research_findings_social_account_id_idx").on(table.socialAccountId),
    index("research_findings_agent_run_id_idx").on(table.agentRunId),
  ],
);

export const researchFindingsRelations = relations(researchFindings, ({ one }) => ({
  socialAccount: one(socialAccounts, {
    fields: [researchFindings.socialAccountId],
    references: [socialAccounts.id],
  }),
  agentRun: one(agentRuns, { fields: [researchFindings.agentRunId], references: [agentRuns.id] }),
}));
