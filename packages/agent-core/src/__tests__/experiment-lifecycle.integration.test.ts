import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createLogger, generateEncryptionKey, TokenEncryptionService } from "@agent/shared";
import { InMemoryObjectStorage } from "@agent/media";
import { MockLLMProvider } from "@agent/llm";
import type {
  AccountInsightsResult,
  MediaInsightsResult,
  PlatformAnalyticsProvider,
  PlatformMetric,
} from "@agent/social-platforms";
import {
  closeDatabase,
  createDatabase,
  AgentProfileRepository,
  ContentRepository,
  ExperimentRepository,
  SocialAccountRepository,
  SocialConnectionRepository,
} from "@agent/database";
import { buildAgentSystem } from "../factory.js";
import type { ExperimentDraft } from "../experiments/experiment-validation.js";

/**
 * The Phase 6 loop end to end, against a real Postgres with a mocked platform:
 *
 *   create -> variants -> attach content -> publish (mock) -> analytics (mock)
 *          -> evaluate -> persist result
 *
 * Nothing here touches Instagram. The analytics provider is scripted so the
 * evaluation has deterministic numbers to compare.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://agent:agent@localhost:5432/agent_growth";
const ENCRYPTION_KEY = generateEncryptionKey();

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

function metric(name: string, value?: number): PlatformMetric {
  return value === undefined ? { name, available: false, reason: "unavailable" } : { name, value, available: true };
}

/** Returns whatever save_rate inputs the test assigned to the post being collected. */
class ScriptedAnalytics implements PlatformAnalyticsProvider {
  readonly platform = "instagram";
  /** externalPostId -> reach/saves used to derive save_rate. */
  readonly byPost = new Map<string, { reach: number; saves: number }>();

  async getMediaInsights(input: { externalPostId: string }): Promise<MediaInsightsResult> {
    const scripted = this.byPost.get(input.externalPostId) ?? { reach: 0, saves: 0 };
    return {
      externalPostId: input.externalPostId,
      mediaType: "IMAGE",
      mediaProductType: "FEED",
      metrics: [
        metric("reach", scripted.reach),
        metric("saved", scripted.saves),
        metric("likes", 0),
        metric("comments", 0),
        metric("shares", 0),
      ],
      outcome: "complete",
      capturedAt: new Date().toISOString(),
      raw: {},
    };
  }

  async getAccountInsights(): Promise<AccountInsightsResult> {
    return {
      platformAccountId: "scripted",
      metrics: [metric("followers_count", 100)],
      outcome: "complete",
      capturedAt: new Date().toISOString(),
      raw: {},
    };
  }
}

function buildSystem(provider: PlatformAnalyticsProvider) {
  return buildAgentSystem({
    db: createDatabase(DATABASE_URL),
    llm: new MockLLMProvider(),
    logger: createLogger({ name: "experiment-test", level: "silent" }),
    objectStorage: new InMemoryObjectStorage(),
    tokenEncryption: new TokenEncryptionService(ENCRYPTION_KEY),
    analyticsProvider: provider,
    // Small on purpose: a full-size experiment would need 10 published posts.
    experimentLimits: { minSamplesPerVariant: 2, minRelativeLift: 0.1, maxExperimentContentPerDay: 50 },
  });
}

async function seedAccount(suffix: string) {
  const db = createDatabase(DATABASE_URL);
  const accounts = new SocialAccountRepository(db);
  const profiles = new AgentProfileRepository(db);
  const connections = new SocialConnectionRepository(db);
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const userId = await accounts.ensureDefaultUser(`experiment-${unique}@example.com`);
  const account = await accounts.create({
    userId,
    platform: "instagram",
    externalAccountId: `experiment-ext-${unique}`,
    displayName: "Experiment Test Account",
  });
  await profiles.create({ socialAccountId: account.id, niche: "test" });
  await connections.upsert({
    socialAccountId: account.id,
    platform: "instagram",
    platformAccountId: `1784140${Math.floor(Math.random() * 1_000_000)}`,
    accountType: "business",
    accessTokenEncrypted: new TokenEncryptionService(ENCRYPTION_KEY).encrypt("TOKEN"),
    scopes: ["instagram_manage_insights"],
  });

  return account;
}

/** Creates a published post already attached to an experiment arm. */
async function publishPostForVariant(
  system: ReturnType<typeof buildAgentSystem>,
  accountId: string,
  experimentId: string,
  variantId: string,
  externalPostId: string,
  provider: ScriptedAnalytics,
  scripted: { reach: number; saves: number },
) {
  const db = createDatabase(DATABASE_URL);
  const profiles = new AgentProfileRepository(db);
  const content = new ContentRepository(db);
  const profile = (await profiles.findBySocialAccountId(accountId))!;

  const idea = await content.createIdea({
    agentProfileId: profile.id,
    title: `Experiment post ${externalPostId}`,
    format: "image",
    contentPillar: "education",
  });
  const post = await content.createPost({ socialAccountId: accountId, contentIdeaId: idea.id, status: "draft" });

  await system.experimentService.attachContent(experimentId, variantId, post.id);
  await content.updatePostStatus(post.id, "published", { publishedAt: new Date(Date.now() - 3 * 60 * 60_000) });

  provider.byPost.set(externalPostId, scripted);
  await system.analyticsService.schedulePostCollection({
    contentPostId: post.id,
    socialAccountId: accountId,
    externalPostId,
    platform: "instagram",
    publishedAt: new Date(Date.now() - 3 * 60 * 60_000),
  });
  await system.analyticsService.collectForPost(post.id, { window: "initial" });

  return post;
}

function draft(overrides: Partial<ExperimentDraft> = {}): ExperimentDraft {
  return {
    name: "Hook style",
    hypothesis: "Pain-point hooks produce more saves than generic hooks.",
    variable: "hook",
    primaryMetric: "save_rate",
    minSamplesPerVariant: 2,
    variants: [
      { name: "control", role: "control", variableValue: "generic" },
      { name: "variant", role: "variant", variableValue: "pain_point" },
    ],
    ...overrides,
  };
}

describe.skipIf(!databaseAvailable)("experiment lifecycle end to end", () => {
  it("runs create -> content -> publish -> analytics -> evaluate and persists a result", async () => {
    const provider = new ScriptedAnalytics();
    const system = buildSystem(provider);
    const account = await seedAccount("e2e");

    // 1. Create and start.
    const created = await system.experimentService.createExperiment(account.id, draft());
    expect(created.created).toBe(true);
    const experimentId = created.experimentId!;

    await system.experimentService.markReady(experimentId);
    await system.experimentService.start(experimentId);

    const { variants } = await system.experimentService.getExperiment(experimentId);
    const control = variants.find((v) => v.role === "control")!;
    const variant = variants.find((v) => v.role === "variant")!;

    // 2. Two published posts per arm; the variant genuinely saves better.
    await publishPostForVariant(system, account.id, experimentId, control.id, "ext-c1", provider, { reach: 1000, saves: 40 });
    await publishPostForVariant(system, account.id, experimentId, control.id, "ext-c2", provider, { reach: 1000, saves: 42 });
    await publishPostForVariant(system, account.id, experimentId, variant.id, "ext-v1", provider, { reach: 1000, saves: 70 });
    await publishPostForVariant(system, account.id, experimentId, variant.id, "ext-v2", provider, { reach: 1000, saves: 72 });

    const progress = await system.experimentService.getProgress(experimentId);
    expect(progress.readyToEvaluate).toBe(true);
    expect(progress.variants.map((v) => v.published).sort()).toEqual([2, 2]);

    // 3. Evaluate.
    const { evaluation } = await system.experimentService.evaluate(experimentId);

    expect(evaluation.outcome).toBe("variant_winner");
    expect(evaluation.controlValue).toBeCloseTo(0.041, 3);
    expect(evaluation.variantValue).toBeCloseTo(0.071, 3);
    expect(evaluation.relativeLift).toBeGreaterThan(0.5);
    // Directional, never overstated.
    expect(evaluation.conclusion).toContain("directional");
    expect(evaluation.confidence).toBe("low");

    // 4. Result persisted and the experiment closed out.
    const after = await system.experimentService.getExperiment(experimentId);
    expect(after.experiment.status).toBe("completed");
    expect(after.evaluations).toHaveLength(1);
    expect(after.evaluations[0]!.outcome).toBe("variant_winner");
  });

  it("does not record a second result when evaluation is repeated over unchanged data", async () => {
    const provider = new ScriptedAnalytics();
    const system = buildSystem(provider);
    const account = await seedAccount("idem");

    const created = await system.experimentService.createExperiment(account.id, draft());
    const experimentId = created.experimentId!;
    await system.experimentService.start(experimentId);

    const { variants } = await system.experimentService.getExperiment(experimentId);
    const control = variants.find((v) => v.role === "control")!;
    const variant = variants.find((v) => v.role === "variant")!;

    await publishPostForVariant(system, account.id, experimentId, control.id, "idem-c1", provider, { reach: 1000, saves: 40 });
    await publishPostForVariant(system, account.id, experimentId, control.id, "idem-c2", provider, { reach: 1000, saves: 40 });
    await publishPostForVariant(system, account.id, experimentId, variant.id, "idem-v1", provider, { reach: 1000, saves: 80 });
    await publishPostForVariant(system, account.id, experimentId, variant.id, "idem-v2", provider, { reach: 1000, saves: 80 });

    const first = await system.experimentService.evaluate(experimentId);
    const second = await system.experimentService.evaluate(experimentId);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.evaluation.evaluationKey).toBe(first.evaluation.evaluationKey);

    const { evaluations } = await system.experimentService.getExperiment(experimentId);
    expect(evaluations).toHaveLength(1);
  });

  it("returns insufficient_data rather than a winner when an arm is short of its target", async () => {
    const provider = new ScriptedAnalytics();
    const system = buildSystem(provider);
    const account = await seedAccount("short");

    const created = await system.experimentService.createExperiment(account.id, draft());
    const experimentId = created.experimentId!;
    await system.experimentService.start(experimentId);

    const { variants } = await system.experimentService.getExperiment(experimentId);
    const control = variants.find((v) => v.role === "control")!;
    const variant = variants.find((v) => v.role === "variant")!;

    // The variant looks far better, but only has one post.
    await publishPostForVariant(system, account.id, experimentId, control.id, "short-c1", provider, { reach: 1000, saves: 10 });
    await publishPostForVariant(system, account.id, experimentId, control.id, "short-c2", provider, { reach: 1000, saves: 10 });
    await publishPostForVariant(system, account.id, experimentId, variant.id, "short-v1", provider, { reach: 1000, saves: 90 });

    const progress = await system.experimentService.getProgress(experimentId);
    expect(progress.readyToEvaluate).toBe(false);

    const { evaluation } = await system.experimentService.evaluate(experimentId);
    expect(evaluation.outcome).toBe("insufficient_data");
    expect(evaluation.winner).toBeUndefined();

    // Still running, so more samples can accumulate.
    const after = await system.experimentService.getExperiment(experimentId);
    expect(after.experiment.status).toBe("running");
  });
});

describe.skipIf(!databaseAvailable)("experiment safety rules", () => {
  it("rejects a second experiment on a variable already under test", async () => {
    const system = buildSystem(new ScriptedAnalytics());
    const account = await seedAccount("concurrency");

    const first = await system.experimentService.createExperiment(account.id, draft());
    await system.experimentService.start(first.experimentId!);

    const second = await system.experimentService.createExperiment(account.id, draft({ name: "Hook style again" }));

    expect(second.created).toBe(false);
    expect(second.validation.errors.map((e) => e.code)).toContain("VARIABLE_ALREADY_UNDER_TEST");
  });

  it("blocks new content on a cancelled experiment and cancels its arms", async () => {
    const system = buildSystem(new ScriptedAnalytics());
    const account = await seedAccount("cancelled");

    const created = await system.experimentService.createExperiment(account.id, draft());
    const experimentId = created.experimentId!;
    await system.experimentService.start(experimentId);
    await system.experimentService.cancel(experimentId, "no longer needed");

    const { variants, experiment } = await system.experimentService.getExperiment(experimentId);
    expect(experiment.status).toBe("cancelled");
    expect(variants.every((v) => v.status === "cancelled")).toBe(true);

    const db = createDatabase(DATABASE_URL);
    const profiles = new AgentProfileRepository(db);
    const content = new ContentRepository(db);
    const profile = (await profiles.findBySocialAccountId(account.id))!;
    const idea = await content.createIdea({ agentProfileId: profile.id, title: "late", format: "image" });
    const post = await content.createPost({ socialAccountId: account.id, contentIdeaId: idea.id, status: "draft" });

    await expect(
      system.experimentService.attachContent(experimentId, variants[0]!.id, post.id),
    ).rejects.toThrow(/cancelled/i);
  });

  it("keeps past experiments and their results after a new one starts", async () => {
    const system = buildSystem(new ScriptedAnalytics());
    const account = await seedAccount("history");

    const first = await system.experimentService.createExperiment(account.id, draft());
    await system.experimentService.start(first.experimentId!);
    await system.experimentService.cancel(first.experimentId!, "superseded");

    const second = await system.experimentService.createExperiment(account.id, draft({ name: "Second run" }));
    expect(second.created).toBe(true);

    // History is immutable: the cancelled experiment is still there.
    const all = await system.experimentService.listForAccount(account.id);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((e) => e.id === first.experimentId)).toBe(true);
  });

  it("interleaves the publishing order so one arm does not cluster in time", async () => {
    const system = buildSystem(new ScriptedAnalytics());
    const account = await seedAccount("schedule");

    const created = await system.experimentService.createExperiment(account.id, draft());
    const schedule = await system.experimentService.planSchedule(created.experimentId!);

    expect(schedule).toHaveLength(4); // 2 arms x 2 samples
    // Alternating, not "all controls then all variants".
    expect(schedule[0]!.role).not.toBe(schedule[1]!.role);
  });
});

describe.skipIf(!databaseAvailable)("Phase 6 does not mutate strategy", () => {
  it("leaves strategy_versions untouched across a full experiment run", async () => {
    const provider = new ScriptedAnalytics();
    const system = buildSystem(provider);
    const account = await seedAccount("nostrategy");

    const before = await system.repositories.strategyRepository.listVersions(account.id).catch(() => []);

    const created = await system.experimentService.createExperiment(account.id, draft());
    const experimentId = created.experimentId!;
    await system.experimentService.start(experimentId);

    const { variants } = await system.experimentService.getExperiment(experimentId);
    const control = variants.find((v) => v.role === "control")!;
    const variant = variants.find((v) => v.role === "variant")!;

    await publishPostForVariant(system, account.id, experimentId, control.id, "ns-c1", provider, { reach: 1000, saves: 10 });
    await publishPostForVariant(system, account.id, experimentId, control.id, "ns-c2", provider, { reach: 1000, saves: 10 });
    await publishPostForVariant(system, account.id, experimentId, variant.id, "ns-v1", provider, { reach: 1000, saves: 90 });
    await publishPostForVariant(system, account.id, experimentId, variant.id, "ns-v2", provider, { reach: 1000, saves: 90 });

    const { evaluation } = await system.experimentService.evaluate(experimentId);
    expect(evaluation.outcome).toBe("variant_winner");

    // A decisive result must still not change what the account is trying to do.
    const after = await system.repositories.strategyRepository.listVersions(account.id).catch(() => []);
    expect(after.length).toBe(before.length);
  });

  it("records the result so Phase 7 has everything it needs to decide later", async () => {
    const provider = new ScriptedAnalytics();
    const system = buildSystem(provider);
    const account = await seedAccount("handoff");

    const created = await system.experimentService.createExperiment(account.id, draft());
    const experimentId = created.experimentId!;
    await system.experimentService.start(experimentId);

    const { variants } = await system.experimentService.getExperiment(experimentId);
    const control = variants.find((v) => v.role === "control")!;
    const variant = variants.find((v) => v.role === "variant")!;

    await publishPostForVariant(system, account.id, experimentId, control.id, "ho-c1", provider, { reach: 1000, saves: 20 });
    await publishPostForVariant(system, account.id, experimentId, control.id, "ho-c2", provider, { reach: 1000, saves: 20 });
    await publishPostForVariant(system, account.id, experimentId, variant.id, "ho-v1", provider, { reach: 1000, saves: 60 });
    await publishPostForVariant(system, account.id, experimentId, variant.id, "ho-v2", provider, { reach: 1000, saves: 60 });

    await system.experimentService.evaluate(experimentId);

    const repo = new ExperimentRepository(createDatabase(DATABASE_URL));
    const stored = await repo.findLatestEvaluation(experimentId);

    // Everything a later phase needs to judge the evidence for itself.
    expect(stored).not.toBeNull();
    expect(stored!.outcome).toBe("variant_winner");
    expect(stored!.primaryMetric).toBe("save_rate");
    expect(stored!.sampleSizes).toMatchObject({ control: 2, variant: 2 });
    expect(stored!.confidence).toBeTruthy();

    const detail = stored!.detail as { thresholds?: Record<string, number>; reasons?: string[]; summaries?: unknown[] };
    expect(detail.thresholds).toBeTruthy();
    expect(detail.reasons?.length).toBeGreaterThan(0);
    expect(detail.summaries?.length).toBe(2);

    const experiment = await repo.findById(experimentId);
    expect(experiment!.variable).toBe("hook");
  });
});
