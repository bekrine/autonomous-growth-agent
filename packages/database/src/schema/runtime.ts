import { relations } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { socialAccounts } from "./core.js";
import { agentActionStatusEnum, agentRunStatusEnum, outboxEventStatusEnum } from "./enums.js";

/**
 * One row per orchestrator execution. This is the audit root: every
 * decision and action an agent takes is traceable back to a run.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    status: agentRunStatusEnum("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_runs_social_account_id_idx").on(table.socialAccountId),
    index("agent_runs_status_idx").on(table.status),
  ],
);

/**
 * A structured, auditable summary of what an agent decided and why.
 * Deliberately does NOT store chain-of-thought/raw prompts — only a
 * concise decision label, a human-readable reason, and metadata.
 */
export const agentDecisions = pgTable(
  "agent_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    agentName: text("agent_name").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("agent_decisions_agent_run_id_idx").on(table.agentRunId)],
);

/**
 * A concrete effect the system took (or attempted) as a result of a
 * decision — e.g. calling a tool. Every autonomous action must have a row
 * here so it can be replayed/audited.
 */
export const agentActions = pgTable(
  "agent_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    agentDecisionId: uuid("agent_decision_id").references(() => agentDecisions.id, {
      onDelete: "set null",
    }),
    actionType: text("action_type").notNull(),
    status: agentActionStatusEnum("status").notNull().default("pending"),
    payload: jsonb("payload").notNull().default({}),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_actions_agent_run_id_idx").on(table.agentRunId),
    index("agent_actions_agent_decision_id_idx").on(table.agentDecisionId),
  ],
);

/**
 * Transactional outbox. A business-record write and its outbox row are
 * inserted in the same DB transaction; a separate publisher process polls
 * pending rows and pushes them onto BullMQ, giving at-least-once delivery
 * without a dual-write race between Postgres and Redis.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: outboxEventStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    index("outbox_events_status_idx").on(table.status),
    index("outbox_events_aggregate_idx").on(table.aggregateType, table.aggregateId),
  ],
);

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  socialAccount: one(socialAccounts, {
    fields: [agentRuns.socialAccountId],
    references: [socialAccounts.id],
  }),
  decisions: many(agentDecisions),
  actions: many(agentActions),
}));

export const agentDecisionsRelations = relations(agentDecisions, ({ one, many }) => ({
  agentRun: one(agentRuns, { fields: [agentDecisions.agentRunId], references: [agentRuns.id] }),
  actions: many(agentActions),
}));

export const agentActionsRelations = relations(agentActions, ({ one }) => ({
  agentRun: one(agentRuns, { fields: [agentActions.agentRunId], references: [agentRuns.id] }),
  agentDecision: one(agentDecisions, {
    fields: [agentActions.agentDecisionId],
    references: [agentDecisions.id],
  }),
}));
