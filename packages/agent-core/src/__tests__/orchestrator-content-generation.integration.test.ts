import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createLogger } from "@agent/shared";
import { MockLLMProvider, fakeFromSchema, type LLMProvider, type StructuredGenerationInput } from "@agent/llm";
import { InMemoryObjectStorage } from "@agent/media";
import {
  closeDatabase,
  createDatabase,
  SocialAccountRepository,
} from "@agent/database";
import { buildAgentSystem } from "../factory.js";

/**
 * Integration test against a real Postgres instance. Skips automatically
 * when no database is reachable — same pattern as orchestrator.integration.test.ts.
 * Exercises the full Phase 3 pipeline: ContentIdea -> ContentCreator ->
 * media generation -> Reviewer -> (regenerate on rejection, up to the max)
 * -> READY_FOR_PUBLISHING or REVIEW_FAILED.
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

/** Always rejects reviews (with actionable feedback) so the regeneration loop runs to its limit. */
class AlwaysRejectingReviewLLM implements LLMProvider {
  readonly name = "test-always-rejecting";
  async generateText(): Promise<never> {
    throw new Error("not used");
  }
  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    if (input.schemaName === "ReviewResult") {
      return {
        approved: false,
        score: 0.3,
        qualityScore: 0.3,
        brandScore: 0.5,
        safetyScore: 1,
        issues: [{ type: "quality", message: "The opening hook is too generic." }],
        warnings: [],
        recommendedChanges: ["Use a more specific developer pain point."],
      } as unknown as T;
    }
    return fakeFromSchema(input.schema);
  }
}

async function seedAccountWithIdea(db: ReturnType<typeof createDatabase>, system: ReturnType<typeof buildAgentSystem>, suffix: string) {
  const accounts = new SocialAccountRepository(db);
  const userId = await accounts.ensureDefaultUser(`content-gen-${suffix}-${Date.now()}@example.com`);
  const account = await accounts.create({
    userId,
    platform: "instagram",
    externalAccountId: `content-gen-${suffix}-${Date.now()}`,
    displayName: "Content Generation Test Account",
  });
  const profile = await system.repositories.agentProfileRepository.create({
    socialAccountId: account.id,
    niche: "AI tools for developers",
    audienceDescription: "junior developers",
  });
  const idea = await system.repositories.contentRepository.createIdea({
    agentProfileId: profile.id,
    title: "3 AI tools that save developers hours",
    format: "reel",
    contentPillar: "AI tools",
    targetAudience: "junior developers",
    hook: "You're probably wasting time doing these three things manually.",
    objective: "shares",
  });
  return { account, idea };
}

describe.skipIf(!databaseAvailable)("AgentOrchestrator.generateContent (integration)", () => {
  it("runs ContentIdea -> ContentCreator -> media -> Reviewer -> READY_FOR_PUBLISHING and records the full audit trail", async () => {
    const db = createDatabase(DATABASE_URL);
    const logger = createLogger({ name: "test", level: "silent" });
    const system = buildAgentSystem({ db, llm: new MockLLMProvider(), logger, objectStorage: new InMemoryObjectStorage() });
    const { account, idea } = await seedAccountWithIdea(db, system, "happy");

    const outcome = await system.orchestrator.generateContent(account.id, idea.id);

    expect(outcome.status).toBe("ready_for_publishing");
    expect(outcome.generationVersion).toBe(1);

    const post = await system.repositories.contentRepository.findPostByIdeaId(idea.id);
    expect(post?.status).toBe("ready_for_publishing");
    expect(post?.currentGenerationVersion).toBe(1);

    const generations = await system.repositories.contentGenerationRepository.listByPostId(post!.id);
    expect(generations).toHaveLength(1);
    expect(generations[0].format).toBe("reel");

    const review = await system.repositories.contentGenerationRepository.findReviewByGenerationId(generations[0].id);
    expect(review?.approved).toBe(true);

    const assets = await system.repositories.contentGenerationRepository.listAssetsByGenerationId(generations[0].id);
    expect(assets.length).toBeGreaterThan(0);
    expect(assets[0].status).toBe("completed");
    expect(assets[0].provider).toBe("mock");

    const decisions = await system.repositories.agentRunRepository.listDecisions(outcome.runId);
    const decisionTypes = decisions.map((d) => d.decision);
    expect(decisionTypes).toContain("content_generated");
    expect(decisionTypes).toContain("content_approved");
  });

  it("regenerates on rejection up to the configured max, then marks REVIEW_FAILED without an infinite loop", { timeout: 20_000 }, async () => {
    const db = createDatabase(DATABASE_URL);
    const logger = createLogger({ name: "test", level: "silent" });
    const system = buildAgentSystem({ db, llm: new AlwaysRejectingReviewLLM(), logger, maxRegenerationAttempts: 3, objectStorage: new InMemoryObjectStorage() });
    const { account, idea } = await seedAccountWithIdea(db, system, "failure");

    const outcome = await system.orchestrator.generateContent(account.id, idea.id);

    expect(outcome.status).toBe("review_failed");
    expect(outcome.generationVersion).toBe(3);

    const post = await system.repositories.contentRepository.findPostByIdeaId(idea.id);
    expect(post?.status).toBe("review_failed");
    expect(post?.generationAttempts).toBe(3);

    const generations = await system.repositories.contentGenerationRepository.listByPostId(post!.id);
    expect(generations.map((g) => g.versionNumber)).toEqual([1, 2, 3]);

    for (const generation of generations) {
      const review = await system.repositories.contentGenerationRepository.findReviewByGenerationId(generation.id);
      expect(review?.approved).toBe(false);
    }
  });

  it("does not duplicate rows when the same content-generation run is retried after completion", async () => {
    const db = createDatabase(DATABASE_URL);
    const logger = createLogger({ name: "test", level: "silent" });
    const system = buildAgentSystem({ db, llm: new MockLLMProvider(), logger, objectStorage: new InMemoryObjectStorage() });
    const { account, idea } = await seedAccountWithIdea(db, system, "idempotent");

    const first = await system.orchestrator.generateContent(account.id, idea.id);
    const second = await system.orchestrator.generateContent(account.id, idea.id, { runId: first.runId });

    expect(second.status).toBe("ready_for_publishing");
    expect(second.contentPostId).toBe(first.contentPostId);

    const generations = await system.repositories.contentGenerationRepository.listByPostId(first.contentPostId);
    expect(generations).toHaveLength(1);
  });
});
