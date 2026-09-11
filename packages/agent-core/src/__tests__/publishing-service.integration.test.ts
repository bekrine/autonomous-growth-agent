import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createLogger, TokenEncryptionService, generateEncryptionKey } from "@agent/shared";
import { MockLLMProvider } from "@agent/llm";
import { KillSwitchStore } from "@agent/policies";
import { MockInstagramAdapter, PublishingError } from "@agent/social-platforms";
import { closeDatabase, createDatabase, SocialAccountRepository } from "@agent/database";
import { buildAgentSystem } from "../factory.js";

/**
 * Exercises the real PublishingService against real Postgres, with
 * MockInstagramAdapter standing in for Meta — no test can ever publish to a
 * real Instagram account. Skips when no database is reachable.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://agent:agent@localhost:5432/agent_growth";
const ENCRYPTION_KEY = generateEncryptionKey();
/** A public JPEG URL — Meta requires JPEG and a publicly reachable host. */
const PUBLIC_JPEG = "https://cdn.example.com/generated/post.jpg";

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

type System = ReturnType<typeof buildAgentSystem>;

function buildSystem(overrides: Parameters<typeof buildAgentSystem>[0] extends infer T ? Partial<T> : never = {}) {
  const db = createDatabase(DATABASE_URL);
  return buildAgentSystem({
    db,
    llm: new MockLLMProvider(),
    logger: createLogger({ name: "test", level: "silent" }),
    tokenEncryption: new TokenEncryptionService(ENCRYPTION_KEY),
    publishingLimits: { maxPerDay: 5, maxPerHour: 5, minMinutesBetweenPosts: 0 },
    ...overrides,
  } as Parameters<typeof buildAgentSystem>[0]);
}

/**
 * Seeds an account with a connection and a content post whose latest
 * generation is approved and carries a publishable JPEG asset.
 */
async function seedPublishableContent(system: System, suffix: string, opts: { mimeType?: string; mediaUrl?: string } = {}) {
  const db = createDatabase(DATABASE_URL);
  const accounts = new SocialAccountRepository(db);
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const userId = await accounts.ensureDefaultUser(`publish-${unique}@example.com`);
  const account = await accounts.create({
    userId,
    platform: "instagram",
    externalAccountId: `publish-ext-${unique}`,
    displayName: "Publishing Test Account",
  });
  const profile = await system.repositories.agentProfileRepository.create({
    socialAccountId: account.id,
    niche: "test",
  });
  const idea = await system.repositories.contentRepository.createIdea({
    agentProfileId: profile.id,
    title: "Publishable idea",
    format: "image",
  });
  const post = await system.repositories.contentRepository.createPost({
    socialAccountId: account.id,
    contentIdeaId: idea.id,
    status: "ready_for_publishing",
  });
  const generation = await system.repositories.contentGenerationRepository.createGeneration({
    contentPostId: post.id,
    versionNumber: 1,
    attemptNumber: 1,
    format: "image",
    payload: { caption: "hello from the agent", altText: "a generated image" },
    status: "generated",
  });
  await system.repositories.contentGenerationRepository.createReview({
    contentGenerationId: generation.id,
    approved: true,
    score: 0.95,
    qualityScore: 0.95,
    brandScore: 0.95,
    safetyScore: 1,
    issues: [],
    warnings: [],
    recommendedChanges: [],
  });
  await system.repositories.contentGenerationRepository.createAsset({
    contentGenerationId: generation.id,
    assetType: "image",
    provider: "test",
    status: "completed",
    url: opts.mediaUrl ?? PUBLIC_JPEG,
    mimeType: opts.mimeType ?? "image/jpeg",
  });

  const encryption = new TokenEncryptionService(ENCRYPTION_KEY);
  const connection = await system.repositories.socialConnectionRepository.upsert({
    socialAccountId: account.id,
    platform: "instagram",
    platformAccountId: `1784140000${Math.floor(Math.random() * 100000)}`,
    platformUsername: "test_account",
    accountType: "business",
    accessTokenEncrypted: encryption.encrypt("PAGE_ACCESS_TOKEN"),
    scopes: ["instagram_basic", "instagram_content_publish"],
  });

  return { account, post, generation, connection };
}

describe.skipIf(!databaseAvailable)("PublishingService (integration)", () => {
  it("publishes approved content end to end and records the external post id", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "happy");

    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });
    expect(enqueued.accepted).toBe(true);

    const outcome = await system.publishingService.execute(enqueued.publishingJobId!);
    expect(outcome.status).toBe("published");
    expect(outcome.externalPostId).toMatch(/^mock_ig_media_/);

    const job = await system.repositories.publishingJobRepository.findById(enqueued.publishingJobId!);
    expect(job?.status).toBe("published");
    expect(job?.externalPostId).toBe(outcome.externalPostId);
    expect(job?.externalContainerId).toBeTruthy();
    expect(job?.publishedAt).toBeTruthy();

    const updatedPost = await system.repositories.contentRepository.findPostById(post.id);
    expect(updatedPost?.status).toBe("published");
  });

  it("keeps the local content id distinct from the platform post id", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "ids");

    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });
    const outcome = await system.publishingService.execute(enqueued.publishingJobId!);

    expect(outcome.externalPostId).not.toBe(post.id);
    const job = await system.repositories.publishingJobRepository.findById(enqueued.publishingJobId!);
    expect(job?.contentPostId).toBe(post.id);
  });

  it("rejects content that has not passed review", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "unapproved");
    await system.repositories.contentRepository.updatePostStatus(post.id, "generated");

    const result = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/has not passed review/);
  });

  it("the kill switch prevents publishing", async () => {
    const killSwitch = new KillSwitchStore(true);
    const system = buildSystem({ killSwitch });
    const { post, connection } = await seedPublishableContent(system, "killswitch");

    const result = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/kill-switch/);
  });

  it("blocks agent-initiated publishing while AUTO_PUBLISH_ENABLED is false", async () => {
    const system = buildSystem({ autoPublishEnabled: false });
    const { post, connection } = await seedPublishableContent(system, "autopublish");

    const agentAttempt = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "agent",
    });
    expect(agentAttempt.accepted).toBe(false);
    expect(agentAttempt.reason).toMatch(/AUTO_PUBLISH_ENABLED/);

    // The same content published by a human is still allowed.
    const humanAttempt = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });
    expect(humanAttempt.accepted).toBe(true);
  });

  it("rejects non-JPEG media (Meta accepts JPEG only)", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "svg", {
      mimeType: "image/svg+xml",
      mediaUrl: "https://cdn.example.com/a.svg",
    });

    const result = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/JPEG/);
  });

  it("rejects media Meta could not reach (localhost)", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "localhost", {
      mediaUrl: "http://localhost:4000/media/a.jpg",
    });

    const result = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/publicly reachable/);
  });

  it("rejects publishing through an expired connection", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "expired");
    await system.repositories.socialConnectionRepository.updateStatus(connection.id, "expired");

    const result = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/expired/i);
  });
});

describe.skipIf(!databaseAvailable)("PublishingService idempotency", () => {
  it("a repeated enqueue does not create a second job", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "idem-enqueue");

    const first = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });
    const second = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.publishingJobId).toBe(first.publishingJobId);

    const jobs = await system.repositories.publishingJobRepository.listByContentPost(post.id);
    expect(jobs).toHaveLength(1);
  });

  it("a worker retry after success does not create a duplicate Instagram post", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "idem-execute");
    const adapter = system.platforms.getPublisher("instagram") as MockInstagramAdapter;
    const before = adapter.publishedPosts.length;

    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });

    const first = await system.publishingService.execute(enqueued.publishingJobId!);
    const second = await system.publishingService.execute(enqueued.publishingJobId!);

    expect(first.status).toBe("published");
    expect(second.status).toBe("skipped");
    expect(second.externalPostId).toBe(first.externalPostId);
    // Exactly one real publish call reached the platform.
    expect(adapter.publishedPosts.length - before).toBe(1);
  });

  it("enqueueing already-published content returns the existing post instead of republishing", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "idem-published");

    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });
    const outcome = await system.publishingService.execute(enqueued.publishingJobId!);

    const again = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });

    expect(again.accepted).toBe(false);
    expect(again.externalPostId).toBe(outcome.externalPostId);
    expect(again.reason).toMatch(/already been published/);
  });
});

describe.skipIf(!databaseAvailable)("PublishingService scheduling and cancellation", () => {
  it("schedules a future job without publishing it", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "schedule");
    const scheduledFor = new Date(Date.now() + 60 * 60_000);

    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      scheduledFor,
      initiatedBy: "human",
    });

    expect(enqueued.accepted).toBe(true);
    expect(enqueued.status).toBe("scheduled");

    const job = await system.repositories.publishingJobRepository.findById(enqueued.publishingJobId!);
    expect(job?.status).toBe("scheduled");
    expect(job?.externalPostId).toBeNull();
  });

  it("a job whose scheduled time has not arrived does not publish", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "schedule-early");
    const adapter = system.platforms.getPublisher("instagram") as MockInstagramAdapter;
    const before = adapter.publishedPosts.length;

    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      scheduledFor: new Date(Date.now() + 60 * 60_000),
      initiatedBy: "human",
    });

    const outcome = await system.publishingService.execute(enqueued.publishingJobId!);
    expect(outcome.status).toBe("failed");
    expect(adapter.publishedPosts.length).toBe(before);
  });

  it("a cancelled job does not publish", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "cancel");
    const adapter = system.platforms.getPublisher("instagram") as MockInstagramAdapter;
    const before = adapter.publishedPosts.length;

    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      scheduledFor: new Date(Date.now() + 60 * 60_000),
      initiatedBy: "human",
    });

    const cancelled = await system.publishingService.cancel(enqueued.publishingJobId!);
    expect(cancelled.cancelled).toBe(true);

    // The worker still gets the job and must refuse it at the final state check.
    const outcome = await system.publishingService.execute(enqueued.publishingJobId!);
    expect(outcome.status).toBe("skipped");
    expect(adapter.publishedPosts.length).toBe(before);

    const job = await system.repositories.publishingJobRepository.findById(enqueued.publishingJobId!);
    expect(job?.status).toBe("cancelled");
  });

  it("a published job can no longer be cancelled", async () => {
    const system = buildSystem();
    const { post, connection } = await seedPublishableContent(system, "cancel-late");

    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });
    await system.publishingService.execute(enqueued.publishingJobId!);

    const cancelled = await system.publishingService.cancel(enqueued.publishingJobId!);
    expect(cancelled.cancelled).toBe(false);
  });
});

describe.skipIf(!databaseAvailable)("PublishingService retry policy", () => {
  it("retries a transient platform error, then gives up at the attempt limit", async () => {
    const failing = new MockInstagramAdapter({
      failWith: new PublishingError("PLATFORM_ERROR", "Instagram is temporarily unavailable."),
    });
    const system = buildSystem({ maxPublishAttempts: 3 });
    // Swap in the failing adapter for this system's registry.
    (system.platforms as unknown as { publishers: Map<string, unknown> }).publishers.set("instagram", failing);

    const { post, connection } = await seedPublishableContent(system, "retry");
    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });

    const first = await system.publishingService.execute(enqueued.publishingJobId!);
    expect(first.status).toBe("failed");
    let job = await system.repositories.publishingJobRepository.findById(enqueued.publishingJobId!);
    expect(job?.status).toBe("retry_scheduled");

    await system.publishingService.execute(enqueued.publishingJobId!);
    await system.publishingService.execute(enqueued.publishingJobId!);

    job = await system.repositories.publishingJobRepository.findById(enqueued.publishingJobId!);
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("PLATFORM_ERROR");
    expect(job?.attempts).toBe(3);

    const finalPost = await system.repositories.contentRepository.findPostById(post.id);
    expect(finalPost?.status).toBe("publish_failed");
  });

  it("does not retry a permanent error such as invalid credentials", async () => {
    const failing = new MockInstagramAdapter({
      failWith: new PublishingError("AUTHENTICATION_FAILED", "The Instagram connection is no longer valid."),
    });
    const system = buildSystem({ maxPublishAttempts: 3 });
    (system.platforms as unknown as { publishers: Map<string, unknown> }).publishers.set("instagram", failing);

    const { post, connection } = await seedPublishableContent(system, "permanent");
    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });

    await system.publishingService.execute(enqueued.publishingJobId!);

    const job = await system.repositories.publishingJobRepository.findById(enqueued.publishingJobId!);
    // Straight to failed on attempt 1 — no retry_scheduled.
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("AUTHENTICATION_FAILED");
    expect(job?.attempts).toBe(1);
  });

  it("treats an unreadable stored credential as permanent, not retryable", async () => {
    const system = buildSystem({ maxPublishAttempts: 3 });
    const { post, connection } = await seedPublishableContent(system, "bad-key");

    // Simulate a rotated/incorrect key: the stored ciphertext can no longer be read.
    const otherKey = new TokenEncryptionService(generateEncryptionKey());
    await system.repositories.socialConnectionRepository.upsert({
      socialAccountId: post.socialAccountId,
      platform: "instagram",
      platformAccountId: (await system.repositories.socialConnectionRepository.findByIdWithSecrets(connection.id))!
        .platformAccountId,
      accountType: "business",
      accessTokenEncrypted: otherKey.encrypt("TOKEN_UNDER_A_DIFFERENT_KEY"),
      scopes: [],
    });

    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });
    await system.publishingService.execute(enqueued.publishingJobId!);

    const job = await system.repositories.publishingJobRepository.findById(enqueued.publishingJobId!);
    // Permanent: straight to failed on attempt 1, no retry_scheduled.
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("AUTHENTICATION_FAILED");
    expect(job?.attempts).toBe(1);
    expect(job?.lastError ?? "").not.toContain("TOKEN_UNDER_A_DIFFERENT_KEY");
  });

  it("never stores a raw access token in the job's error detail", async () => {
    const failing = new MockInstagramAdapter({
      failWith: new PublishingError("PLATFORM_ERROR", "boom", "provider said no"),
    });
    const system = buildSystem();
    (system.platforms as unknown as { publishers: Map<string, unknown> }).publishers.set("instagram", failing);

    const { post, connection } = await seedPublishableContent(system, "no-token-leak");
    const enqueued = await system.publishingService.enqueue({
      contentPostId: post.id,
      socialConnectionId: connection.id,
      initiatedBy: "human",
    });
    await system.publishingService.execute(enqueued.publishingJobId!);

    const job = await system.repositories.publishingJobRepository.findById(enqueued.publishingJobId!);
    expect(job?.lastError ?? "").not.toContain("PAGE_ACCESS_TOKEN");
  });
});
