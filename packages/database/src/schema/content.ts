import { relations } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentProfiles, strategyVersions } from "./agent.js";
import { socialAccounts } from "./core.js";
import { contentIdeaStatusEnum, contentPostStatusEnum, publishingJobStatusEnum } from "./enums.js";

export const contentIdeas = pgTable(
  "content_ideas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentProfileId: uuid("agent_profile_id")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "cascade" }),
    strategyVersionId: uuid("strategy_version_id").references(() => strategyVersions.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    status: contentIdeaStatusEnum("status").notNull().default("proposed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("content_ideas_agent_profile_id_idx").on(table.agentProfileId)],
);

// Generic, platform-agnostic post record. Platform-specific rendering
// concerns live in packages/social-platforms, never here.
export const contentPosts = pgTable(
  "content_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentIdeaId: uuid("content_idea_id").references(() => contentIdeas.id, {
      onDelete: "set null",
    }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    caption: text("caption"),
    mediaUrls: jsonb("media_urls").notNull().default([]),
    status: contentPostStatusEnum("status").notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("content_posts_social_account_id_idx").on(table.socialAccountId),
    index("content_posts_status_idx").on(table.status),
  ],
);

export const publishingJobs = pgTable(
  "publishing_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentPostId: uuid("content_post_id")
      .notNull()
      .references(() => contentPosts.id, { onDelete: "cascade" }),
    status: publishingJobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("publishing_jobs_content_post_id_idx").on(table.contentPostId),
    index("publishing_jobs_status_idx").on(table.status),
  ],
);

export const contentIdeasRelations = relations(contentIdeas, ({ one, many }) => ({
  agentProfile: one(agentProfiles, {
    fields: [contentIdeas.agentProfileId],
    references: [agentProfiles.id],
  }),
  strategyVersion: one(strategyVersions, {
    fields: [contentIdeas.strategyVersionId],
    references: [strategyVersions.id],
  }),
  posts: many(contentPosts),
}));

export const contentPostsRelations = relations(contentPosts, ({ one, many }) => ({
  contentIdea: one(contentIdeas, {
    fields: [contentPosts.contentIdeaId],
    references: [contentIdeas.id],
  }),
  socialAccount: one(socialAccounts, {
    fields: [contentPosts.socialAccountId],
    references: [socialAccounts.id],
  }),
  publishingJobs: many(publishingJobs),
}));

export const publishingJobsRelations = relations(publishingJobs, ({ one }) => ({
  contentPost: one(contentPosts, {
    fields: [publishingJobs.contentPostId],
    references: [contentPosts.id],
  }),
}));
