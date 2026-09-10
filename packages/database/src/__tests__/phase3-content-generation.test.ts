import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase } from "../client.js";
import { SocialAccountRepository } from "../repositories/social-account.repository.js";
import { AgentProfileRepository } from "../repositories/agent-profile.repository.js";
import { ContentRepository } from "../repositories/content.repository.js";
import { ContentGenerationRepository } from "../repositories/content-generation.repository.js";
import { isDatabaseReachable, TEST_DATABASE_URL } from "./test-helpers.js";

const databaseAvailable = await isDatabaseReachable();

afterAll(async () => {
  if (databaseAvailable) await closeDatabase();
});

describe.skipIf(!databaseAvailable)("Phase 3 content-generation repositories", () => {
  it("creates a post-for-idea, versioned generations, a review, and an asset, all traceable", async () => {
    const db = createDatabase(TEST_DATABASE_URL);
    const accounts = new SocialAccountRepository(db);
    const profiles = new AgentProfileRepository(db);
    const content = new ContentRepository(db);
    const generations = new ContentGenerationRepository(db);

    const userId = await accounts.ensureDefaultUser(`phase3-${Date.now()}@example.com`);
    const account = await accounts.create({
      userId,
      platform: "instagram",
      externalAccountId: `phase3-ext-${Date.now()}`,
      displayName: "Phase 3 Test Account",
    });
    const profile = await profiles.create({ socialAccountId: account.id, niche: "test niche" });
    const idea = await content.createIdea({ agentProfileId: profile.id, title: "Test idea", format: "image" });

    let post = await content.findPostByIdeaId(idea.id);
    expect(post).toBeNull();
    post = await content.createPost({ socialAccountId: account.id, contentIdeaId: idea.id, status: "idea" });
    expect(post.currentGenerationVersion).toBe(0);

    const v1 = await generations.createGeneration({
      contentPostId: post.id,
      versionNumber: 1,
      attemptNumber: 1,
      format: "image",
      payload: { hook: "test hook" },
      status: "generated",
      llmProvider: "mock",
    });
    const v1Review = await generations.createReview({
      contentGenerationId: v1.id,
      approved: false,
      score: 0.4,
      qualityScore: 0.4,
      brandScore: 0.5,
      safetyScore: 1,
      issues: [{ type: "quality", message: "too generic" }],
      warnings: [],
      recommendedChanges: ["be more specific"],
    });
    expect(v1Review.approved).toBe(false);

    const v2 = await generations.createGeneration({
      contentPostId: post.id,
      versionNumber: 2,
      attemptNumber: 2,
      format: "image",
      payload: { hook: "better hook" },
      status: "generated",
      llmProvider: "mock",
    });
    await generations.createReview({
      contentGenerationId: v2.id,
      approved: true,
      score: 0.9,
      qualityScore: 0.9,
      brandScore: 0.9,
      safetyScore: 1,
      issues: [],
      warnings: [],
      recommendedChanges: [],
    });

    const asset = await generations.createAsset({
      contentGenerationId: v2.id,
      assetType: "image",
      provider: "mock",
      status: "completed",
      storageKey: "content/test.png",
      url: "http://localhost:4000/media/content/test.png",
    });
    expect(asset.status).toBe("completed");

    const history = await generations.listByPostId(post.id);
    expect(history.map((g) => g.versionNumber)).toEqual([1, 2]);

    await content.setCurrentGenerationVersion(post.id, 2);
    await content.updatePostStatus(post.id, "ready_for_publishing");
    const finalPost = await content.findPostById(post.id);
    expect(finalPost?.currentGenerationVersion).toBe(2);
    expect(finalPost?.status).toBe("ready_for_publishing");

    // Idempotency guard: creating the same version number twice must fail (unique constraint).
    await expect(
      generations.createGeneration({
        contentPostId: post.id,
        versionNumber: 2,
        attemptNumber: 3,
        format: "image",
        status: "generated",
      }),
    ).rejects.toThrow();
  });
});
