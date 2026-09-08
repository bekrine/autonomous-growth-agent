import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase } from "../client.js";
import { SocialAccountRepository } from "../repositories/social-account.repository.js";
import { AgentProfileRepository } from "../repositories/agent-profile.repository.js";
import { AgentRunRepository } from "../repositories/agent-run.repository.js";
import { ResearchRepository } from "../repositories/research.repository.js";
import { StrategyRepository } from "../repositories/strategy.repository.js";
import { ContentRepository } from "../repositories/content.repository.js";
import { isDatabaseReachable, TEST_DATABASE_URL } from "./test-helpers.js";

const databaseAvailable = await isDatabaseReachable();

afterAll(async () => {
  if (databaseAvailable) await closeDatabase();
});

describe.skipIf(!databaseAvailable)("Phase 2 repositories", () => {
  it("persists research findings, a strategy version, and content ideas for a run, all traceable by agentRunId", async () => {
    const db = createDatabase(TEST_DATABASE_URL);
    const accounts = new SocialAccountRepository(db);
    const profiles = new AgentProfileRepository(db);
    const runs = new AgentRunRepository(db);
    const research = new ResearchRepository(db);
    const strategy = new StrategyRepository(db);
    const content = new ContentRepository(db);

    const userId = await accounts.ensureDefaultUser(`phase2-${Date.now()}@example.com`);
    const account = await accounts.create({
      userId,
      platform: "instagram",
      externalAccountId: `phase2-ext-${Date.now()}`,
      displayName: "Phase 2 Test Account",
    });
    const profile = await profiles.create({ socialAccountId: account.id, niche: "test niche" });
    const run = await runs.create(account.id);

    const findings = await research.createMany([
      {
        socialAccountId: account.id,
        agentRunId: run.id,
        topic: "Topic A",
        relevanceScore: 0.9,
        audienceInterestScore: 0.8,
        competitionScore: 0.5,
        rationale: "test",
        sourceType: "mock",
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(await research.listByRunId(run.id)).toHaveLength(1);

    const strategyRow = await strategy.create({ agentProfileId: profile.id, name: "Test Strategy" });
    const v1 = await strategy.createVersion({
      strategyId: strategyRow.id,
      versionNumber: 1,
      summary: "v1 summary",
      content: { contentPillars: [] },
      createdBy: "strategy_agent",
      agentRunId: run.id,
    });
    expect(v1.versionNumber).toBe(1);
    expect(await strategy.findVersionByRunId(run.id)).not.toBeNull();

    const v2 = await strategy.createVersion({
      strategyId: strategyRow.id,
      versionNumber: 2,
      summary: "v2 summary",
      content: { contentPillars: [] },
      createdBy: "strategy_agent",
    });
    const versions = await strategy.listVersions(strategyRow.id);
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(v1.id).not.toBe(v2.id);

    const ideas = await content.createIdeas([
      { agentProfileId: profile.id, agentRunId: run.id, title: "Idea 1", priorityScore: 0.7 },
      { agentProfileId: profile.id, agentRunId: run.id, title: "Idea 2", priorityScore: 0.4 },
    ]);
    expect(ideas).toHaveLength(2);
    expect(await content.listIdeasByRunId(run.id)).toHaveLength(2);
  });
});
