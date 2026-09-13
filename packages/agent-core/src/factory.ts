import type { Database } from "@agent/database";
import {
  AgentProfileRepository,
  AgentRunRepository,
  AnalyticsRepository,
  ContentGenerationRepository,
  ContentRepository,
  ExperimentRepository,
  OutboxRepository,
  PublishingJobRepository,
  ResearchRepository,
  SocialAccountRepository,
  SocialConnectionRepository,
  StrategyRepository,
} from "@agent/database";
import type { LLMProvider } from "@agent/llm";
import { SocialPlatformRegistry, InstagramAnalyticsProvider, MetaGraphClient } from "@agent/social-platforms";
import type { PlatformAnalyticsProvider } from "@agent/social-platforms";
import {
  AutoPublishPolicy,
  ContentApprovalPolicy,
  DailyGenerationLimitPolicy,
  HumanApprovalPolicy,
  KillSwitchPolicy,
  KillSwitchStore,
  MediaReadyPolicy,
  PlatformAvailabilityPolicy,
  PolicyEngine,
  PublishableContentPolicy,
  PublishingJobStatePolicy,
  PublishingRateLimitPolicy,
  RateLimitPolicy,
  SocialConnectionPolicy,
} from "@agent/policies";
import type { Logger, TokenEncryptionService } from "@agent/shared";
import type { ImageGenerator, ObjectStorage, VideoGenerator } from "@agent/media";
import { createImageGenerator, createObjectStorage, createVideoGenerator, MediaStorageService } from "@agent/media";
import { ToolRouter } from "./tool-router.js";
import {
  CreateContentBriefTool,
  GenerateImageTool,
  GenerateVideoTool,
  GetAccountTool,
  GetCommentsTool,
  GetPostAnalyticsTool,
  GetStrategyTool,
  PublishPostTool,
  SearchWebTool,
  UpdateStrategyTool,
} from "./tools/index.js";
import {
  AnalyticsAgent,
  ExperimentAgent,
  ContentCreatorAgent,
  ContentPlannerAgent,
  ResearchAgent,
  ReviewerAgent,
  StrategyAgent,
} from "./agents/index.js";
import { AgentOrchestrator } from "./orchestrator.js";
import { AgentContextLoader } from "./context/agent-context-loader.js";
import { MockResearchProvider, type ResearchProvider } from "./research/research-provider.js";
import { AgentRunService } from "./agent-run-service.js";
import { PublishingService } from "./publishing/publishing-service.js";
import { AnalyticsService } from "./analytics/analytics-service.js";
import { ExperimentService } from "./experiments/experiment-service.js";
import type { ExperimentLimits } from "./experiments/experiment-config.js";
import type { CollectionWindow } from "./analytics/collection-windows.js";
import { StoredAssetMediaResolver } from "./publishing/public-media-resolver.js";

export interface BuildAgentSystemOptions {
  db: Database;
  llm: LLMProvider;
  logger: Logger;
  killSwitch?: KillSwitchStore;
  /** Swappable per rule 21 — defaults to the mock provider until a real research source exists. */
  researchProvider?: ResearchProvider;
  /** Swappable — defaults to MockImageGenerator until an image-gen key is configured. */
  imageGenerator?: ImageGenerator;
  videoGenerator?: VideoGenerator;
  /** Reels render a real video only when true; otherwise they get a cover image. */
  videoGenerationEnabled?: boolean;
  /** Swappable — defaults to local-disk storage until a real STORAGE_* provider is configured. */
  objectStorage?: ObjectStorage;
  mediaStorage?: MediaStorageService;
  /** Hard ceiling on ContentCreator/Reviewer regeneration attempts. Defaults to 3. */
  maxRegenerationAttempts?: number;
  /** Per-account daily cap on media-generation calls. Defaults to 50. */
  maxDailyMediaGenerations?: number;

  // --- Phase 4 publishing ---
  /** Off by default: Instagram resolves to MockInstagramAdapter and nothing reaches Meta. */
  instagramPublishingEnabled?: boolean;
  metaApiVersion?: string;
  metaGraphHost?: string;
  /** Required to decrypt stored tokens; without it publishing fails closed. */
  tokenEncryption?: TokenEncryptionService | null;
  /** Off by default: agent-initiated publishing is blocked until the manual path is proven. */
  autoPublishEnabled?: boolean;
  publishingLimits?: { maxPerDay: number; maxPerHour: number; minMinutesBetweenPosts: number };
  maxPublishAttempts?: number;
  /** Phase 5 analytics. All optional — omitted means "use defaults"/"no provider". */
  analyticsProvider?: PlatformAnalyticsProvider | null;
  analyticsCollectionWindows?: CollectionWindow[];
  analyticsBaselinePostCount?: number;
  analyticsMaxCollectionAttempts?: number;
  experimentLimits?: Partial<ExperimentLimits>;
}

/**
 * Wires repositories, the policy engine, tools, the context loader, agents
 * and the orchestrator together. This is the single place that knows how
 * the pieces fit — everything else (API, workers) depends only on the
 * returned interfaces.
 */
export function buildAgentSystem(options: BuildAgentSystemOptions) {
  const socialAccountRepository = new SocialAccountRepository(options.db);
  const agentProfileRepository = new AgentProfileRepository(options.db);
  const strategyRepository = new StrategyRepository(options.db);
  const agentRunRepository = new AgentRunRepository(options.db);
  const contentRepository = new ContentRepository(options.db);
  const contentGenerationRepository = new ContentGenerationRepository(options.db);
  const analyticsRepository = new AnalyticsRepository(options.db);
  const experimentRepository = new ExperimentRepository(options.db);
  const researchRepository = new ResearchRepository(options.db);
  const socialConnectionRepository = new SocialConnectionRepository(options.db);
  const publishingJobRepository = new PublishingJobRepository(options.db);
  const outboxRepository = new OutboxRepository(options.db);
  const platforms = new SocialPlatformRegistry({
    instagramPublishingEnabled: options.instagramPublishingEnabled,
    metaApiVersion: options.metaApiVersion,
    metaGraphHost: options.metaGraphHost,
    logger: options.logger,
  });
  const killSwitch = options.killSwitch ?? new KillSwitchStore();

  const imageGenerator = options.imageGenerator ?? createImageGenerator({});
  const videoGenerator = options.videoGenerator ?? createVideoGenerator({});
  const objectStorage =
    options.objectStorage ?? createObjectStorage({ localDir: "./storage", publicBaseUrl: "http://localhost:4000/media" });
  // One service wraps whichever ObjectStorage was selected; nothing downstream
  // knows whether that is R2, local disk, or the in-memory test double.
  const mediaStorage = options.mediaStorage ?? new MediaStorageService(objectStorage, options.logger);

  const publishingLimits = options.publishingLimits ?? {
    maxPerDay: 5,
    maxPerHour: 2,
    minMinutesBetweenPosts: 10,
  };

  const policyEngine = new PolicyEngine([
    // Kill switch stays first so it can veto everything, publishing included.
    new KillSwitchPolicy(killSwitch),
    new PlatformAvailabilityPolicy(),
    new ContentApprovalPolicy(),
    new HumanApprovalPolicy(),
    new RateLimitPolicy(),
    new DailyGenerationLimitPolicy(options.maxDailyMediaGenerations ?? 50),
    // Publishing-specific (each no-ops for non-publishing actions).
    new PublishingJobStatePolicy(),
    new PublishableContentPolicy(),
    new SocialConnectionPolicy(),
    new MediaReadyPolicy(),
    new AutoPublishPolicy(options.autoPublishEnabled ?? false),
    new PublishingRateLimitPolicy(publishingLimits),
  ]);

  const mediaResolver = new StoredAssetMediaResolver(contentGenerationRepository);

  const publishingService = new PublishingService({
    db: options.db,
    contentRepository,
    contentGenerationRepository,
    publishingJobRepository,
    socialConnectionRepository,
    agentRunRepository,
    outboxRepository,
    policyEngine,
    platforms,
    mediaResolver,
    tokenEncryption: options.tokenEncryption ?? null,
    logger: options.logger,
    maxAttempts: options.maxPublishAttempts ?? 3,
  });

  // Real Meta insights only when publishing is enabled and credentials exist;
  // otherwise analytics has no provider and degrades to "not configured"
  // rather than inventing numbers.
  const analyticsProvider =
    options.analyticsProvider ??
    (options.instagramPublishingEnabled && options.metaApiVersion
      ? new InstagramAnalyticsProvider(
          new MetaGraphClient({
            apiVersion: options.metaApiVersion,
            host: options.metaGraphHost ?? "https://graph.facebook.com",
          }),
        )
      : null);

  const analyticsService = new AnalyticsService({
    analyticsRepository,
    contentRepository,
    contentGenerationRepository,
    publishingJobRepository,
    socialConnectionRepository,
    analyticsProvider,
    tokenEncryption: options.tokenEncryption ?? null,
    logger: options.logger,
    collectionWindows: options.analyticsCollectionWindows,
    baselinePostCount: options.analyticsBaselinePostCount,
    maxCollectionAttempts: options.analyticsMaxCollectionAttempts,
  });

  // Experiments orchestrate the existing services; they never reimplement
  // content generation, publishing or metrics.
  const experimentService = new ExperimentService({
    experimentRepository,
    contentRepository,
    agentProfileRepository,
    outboxRepository,
    analyticsService,
    publishingService,
    logger: options.logger,
    limits: options.experimentLimits,
  });

  const toolRouter = new ToolRouter(
    [
      new SearchWebTool(),
      new GetAccountTool(socialAccountRepository),
      new GetStrategyTool(strategyRepository),
      new CreateContentBriefTool(options.llm),
      new PublishPostTool(publishingService),
      new GetPostAnalyticsTool(platforms),
      new GetCommentsTool(platforms),
      new UpdateStrategyTool(strategyRepository),
      new GenerateImageTool(imageGenerator, mediaStorage),
      new GenerateVideoTool(videoGenerator, mediaStorage),
    ],
    policyEngine,
  );

  const contextLoader = new AgentContextLoader({
    socialAccountRepository,
    agentProfileRepository,
    strategyRepository,
    contentRepository,
    analyticsRepository,
    experimentRepository,
    researchRepository,
    killSwitch,
  });

  const researchProvider = options.researchProvider ?? new MockResearchProvider();

  const orchestrator = new AgentOrchestrator(
    {
      db: options.db,
      contextLoader,
      agentRunRepository,
      researchRepository,
      strategyRepository,
      contentRepository,
      contentGenerationRepository,
      toolRouter,
      llm: options.llm,
      logger: options.logger,
      maxRegenerationAttempts: options.maxRegenerationAttempts ?? 3,
      imageGeneratorName: imageGenerator.name,
      videoGeneratorName: videoGenerator.name,
      videoGenerationEnabled: options.videoGenerationEnabled ?? false,
    },
    [new ResearchAgent(researchProvider), new StrategyAgent(), new ContentPlannerAgent()],
    { contentCreator: new ContentCreatorAgent(), reviewer: new ReviewerAgent() },
    // Analytics runs on its own entry point (analyzePerformance), not in the
    // planning pipeline: interpretation should happen when asked for, not on
    // every run.
    new AnalyticsAgent(),
    {
      analyticsService,
      analyticsRepository,
      socialAccountRepository,
      agentProfileRepository,
    },
    new ExperimentAgent(),
    { experimentRepository },
  );

  const agentRunService = new AgentRunService({
    orchestrator,
    agentRunRepository,
    researchRepository,
    strategyRepository,
    contentRepository,
    contentGenerationRepository,
    agentProfileRepository,
  });

  return {
    orchestrator,
    agentRunService,
    publishingService,
    analyticsService,
    experimentService,
    analyticsProvider,
    mediaResolver,
    platforms,
    toolRouter,
    policyEngine,
    killSwitch,
    contextLoader,
    imageGenerator,
    videoGenerator,
    objectStorage,
    mediaStorage,
    repositories: {
      socialAccountRepository,
      agentProfileRepository,
      strategyRepository,
      agentRunRepository,
      contentRepository,
      contentGenerationRepository,
      analyticsRepository,
      experimentRepository,
      researchRepository,
      socialConnectionRepository,
      publishingJobRepository,
      outboxRepository,
    },
  };
}
