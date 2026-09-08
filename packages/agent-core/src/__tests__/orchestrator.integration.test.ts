import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createLogger } from "@agent/shared";
import { MockLLMProvider } from "@agent/llm";
import { closeDatabase, createDatabase, SocialAccountRepository } from "@agent/database";
import { buildAgentSystem } from "../factory.js";

/**
 * Integration test against a real Postgres instance (see docker-compose.yml).
 * Skips automatically when no database is reachable. Unlike a mocked unit
 * test, this exercises the real transactional persistence path — the
 * orchestrator reconstructs repositories against each transaction's client,
 * so a pure-mock test of AgentOrchestrator can't meaningfully cover it.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://agent:agent@localhost:5432/agent_growth";

async function isDatabaseReachable(): Promise<boolean> {
  const sql = postgres(DATABASE_URL, { max: 1, connect_timeout: 2 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const databaseAvailable = await isDatabaseReachable();

afterAll(async () => {
  if (databaseAvailable) await closeDatabase();
});

describe.skipIf(!databaseAvailable)("AgentOrchestrator (integration)", () => {
  it("runs Research -> Strategy -> ContentPlanner and persists every stage", async () => {
    const db = createDatabase(DATABASE_URL);
    const logger = createLogger({ name: "test", level: "silent" });
    const system = buildAgentSystem({ db, llm: new MockLLMProvider(), logger });

    const accounts = new SocialAccountRepository(db);
    const userId = await accounts.ensureDefaultUser(`orch-${Date.now()}@example.com`);
    const account = await accounts.create({
      userId,
      platform: "instagram",
      externalAccountId: `orch-ext-${Date.now()}`,
      displayName: "Orchestrator Test Account",
    });
    await system.repositories.agentProfileRepository.create({
      socialAccountId: account.id,
      niche: "test automation",
    });

    const outcome = await system.orchestrator.executeRun(account.id);
    expect(outcome.status).toBe("completed");

    const research = await system.repositories.researchRepository.listByRunId(outcome.runId);
    expect(research.length).toBeGreaterThan(0);

    const decisions = await system.repositories.agentRunRepository.listDecisions(outcome.runId);
    const decisionTypes = decisions.map((d) => d.decision);
    expect(decisionTypes).toContain("research_topics_discovered");
    expect(decisionTypes).toContain("strategy_updated");
    expect(decisionTypes).toContain("content_ideas_planned");

    const strategies = await system.repositories.strategyRepository.findByAgentProfileId(
      (await system.repositories.agentProfileRepository.findBySocialAccountId(account.id))!.id,
    );
    expect(strategies).toHaveLength(1);
    const versions = await system.repositories.strategyRepository.listVersions(strategies[0].id);
    expect(versions).toHaveLength(1);
    expect(versions[0].versionNumber).toBe(1);
    expect(versions[0].agentRunId).toBe(outcome.runId);

    const ideas = await system.repositories.contentRepository.listIdeasByRunId(outcome.runId);
    expect(ideas.length).toBeGreaterThan(0);
    expect(ideas[0].strategyVersionId).toBe(versions[0].id);
  });

  it("retrying the same run does not duplicate research findings, strategy versions, or content ideas", async () => {
    const db = createDatabase(DATABASE_URL);
    const logger = createLogger({ name: "test", level: "silent" });
    const system = buildAgentSystem({ db, llm: new MockLLMProvider(), logger });

    const accounts = new SocialAccountRepository(db);
    const userId = await accounts.ensureDefaultUser(`orch-retry-${Date.now()}@example.com`);
    const account = await accounts.create({
      userId,
      platform: "instagram",
      externalAccountId: `orch-retry-ext-${Date.now()}`,
      displayName: "Orchestrator Retry Test Account",
    });
    await system.repositories.agentProfileRepository.create({
      socialAccountId: account.id,
      niche: "test automation",
    });

    const first = await system.orchestrator.executeRun(account.id);
    const researchAfterFirst = await system.repositories.researchRepository.listByRunId(first.runId);
    const ideasAfterFirst = await system.repositories.contentRepository.listIdeasByRunId(first.runId);

    // Simulate a redelivered queue job for the same run.
    const second = await system.orchestrator.executeRun(account.id, { runId: first.runId });
    expect(second.status).toBe("completed");

    const researchAfterSecond = await system.repositories.researchRepository.listByRunId(first.runId);
    const ideasAfterSecond = await system.repositories.contentRepository.listIdeasByRunId(first.runId);

    expect(researchAfterSecond).toHaveLength(researchAfterFirst.length);
    expect(ideasAfterSecond).toHaveLength(ideasAfterFirst.length);
  });

  it("marks the run failed when the account has no agent profile yet", async () => {
    const db = createDatabase(DATABASE_URL);
    const logger = createLogger({ name: "test", level: "silent" });
    const system = buildAgentSystem({ db, llm: new MockLLMProvider(), logger });

    const accounts = new SocialAccountRepository(db);
    const userId = await accounts.ensureDefaultUser(`orch-nofail-${Date.now()}@example.com`);
    const account = await accounts.create({
      userId,
      platform: "instagram",
      externalAccountId: `orch-nofail-ext-${Date.now()}`,
      displayName: "No Profile Account",
    });
    // Deliberately skip creating an agent_profile row.

    const outcome = await system.orchestrator.executeRun(account.id);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("agent profile");

    const run = await system.repositories.agentRunRepository.findById(outcome.runId);
    expect(run?.status).toBe("failed");
  });
});
