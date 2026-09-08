import type { Database } from "@agent/database";
import {
  AgentProfileRepository,
  AgentRunRepository,
  AnalyticsRepository,
  ContentRepository,
  ExperimentRepository,
  ResearchRepository,
  SocialAccountRepository,
  StrategyRepository,
} from "@agent/database";
import type { LLMProvider } from "@agent/llm";
import { SocialPlatformRegistry } from "@agent/social-platforms";
import {
  ContentApprovalPolicy,
  HumanApprovalPolicy,
  KillSwitchPolicy,
  KillSwitchStore,
  PlatformAvailabilityPolicy,
  PolicyEngine,
  RateLimitPolicy,
} from "@agent/policies";
import type { Logger } from "@agent/shared";
import { ToolRouter } from "./tool-router.js";
import {
  CreateContentBriefTool,
  GetAccountTool,
  GetCommentsTool,
  GetPostAnalyticsTool,
  GetStrategyTool,
  PublishPostTool,
  SearchWebTool,
  UpdateStrategyTool,
} from "./tools/index.js";
import { ContentPlannerAgent, ResearchAgent, StrategyAgent } from "./agents/index.js";
import { AgentOrchestrator } from "./orchestrator.js";
import { AgentContextLoader } from "./context/agent-context-loader.js";
import { MockResearchProvider, type ResearchProvider } from "./research/research-provider.js";
import { AgentRunService } from "./agent-run-service.js";

export interface BuildAgentSystemOptions {
  db: Database;
  llm: LLMProvider;
  logger: Logger;
  killSwitch?: KillSwitchStore;
  /** Swappable per rule 21 — defaults to the mock provider until a real research source exists. */
  researchProvider?: ResearchProvider;
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
  const analyticsRepository = new AnalyticsRepository(options.db);
  const experimentRepository = new ExperimentRepository(options.db);
  const researchRepository = new ResearchRepository(options.db);
  const platforms = new SocialPlatformRegistry();
  const killSwitch = options.killSwitch ?? new KillSwitchStore();

  const policyEngine = new PolicyEngine([
    new KillSwitchPolicy(killSwitch),
    new PlatformAvailabilityPolicy(),
    new ContentApprovalPolicy(),
    new HumanApprovalPolicy(),
    new RateLimitPolicy(),
  ]);

  const toolRouter = new ToolRouter(
    [
      new SearchWebTool(),
      new GetAccountTool(socialAccountRepository),
      new GetStrategyTool(strategyRepository),
      new CreateContentBriefTool(options.llm),
      new PublishPostTool(platforms),
      new GetPostAnalyticsTool(platforms),
      new GetCommentsTool(platforms),
      new UpdateStrategyTool(strategyRepository),
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
      toolRouter,
      llm: options.llm,
      logger: options.logger,
    },
    [new ResearchAgent(researchProvider), new StrategyAgent(), new ContentPlannerAgent()],
  );

  const agentRunService = new AgentRunService({
    orchestrator,
    agentRunRepository,
    researchRepository,
    strategyRepository,
    contentRepository,
    agentProfileRepository,
  });

  return {
    orchestrator,
    agentRunService,
    toolRouter,
    policyEngine,
    killSwitch,
    contextLoader,
    repositories: {
      socialAccountRepository,
      agentProfileRepository,
      strategyRepository,
      agentRunRepository,
      contentRepository,
      analyticsRepository,
      experimentRepository,
      researchRepository,
    },
  };
}
