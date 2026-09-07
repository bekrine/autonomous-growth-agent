import type { Database } from "@agent/database";
import { AgentRunRepository, SocialAccountRepository, StrategyRepository } from "@agent/database";
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

export interface BuildAgentSystemOptions {
  db: Database;
  llm: LLMProvider;
  logger: Logger;
  killSwitch?: KillSwitchStore;
}

/**
 * Wires repositories, the policy engine, tools, agents and the
 * orchestrator together. This is the single place that knows how the
 * pieces fit — everything else depends only on interfaces.
 */
export function buildAgentSystem(options: BuildAgentSystemOptions) {
  const socialAccountRepository = new SocialAccountRepository(options.db);
  const strategyRepository = new StrategyRepository(options.db);
  const agentRunRepository = new AgentRunRepository(options.db);
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

  const orchestrator = new AgentOrchestrator(
    { agentRunRepository, toolRouter, llm: options.llm, logger: options.logger },
    [new ResearchAgent(), new StrategyAgent(), new ContentPlannerAgent()],
  );

  return {
    orchestrator,
    toolRouter,
    policyEngine,
    killSwitch,
    repositories: { socialAccountRepository, strategyRepository, agentRunRepository },
  };
}
