import {
  AgentRunRepository,
  ContentRepository,
  ResearchRepository,
  StrategyRepository,
  type Database,
  type DrizzleClient,
} from "@agent/database";
import type { AgentName, Logger } from "@agent/shared";
import { NotFoundError } from "@agent/shared";
import type { LLMProvider } from "@agent/llm";
import type { Agent, AgentContext, AgentResult } from "./types.js";
import type { ToolRouter } from "./tool-router.js";
import type { AgentContextLoader } from "./context/agent-context-loader.js";
import type { AgentContextData } from "./context/types.js";
import type { ResearchResult } from "./prompts/research.prompt.js";
import type { StrategyResult } from "./prompts/strategy.prompt.js";
import type { ContentPlanResult } from "./prompts/content-planner.prompt.js";

export interface OrchestratorDependencies {
  db: Database;
  contextLoader: AgentContextLoader;
  agentRunRepository: AgentRunRepository;
  researchRepository: ResearchRepository;
  strategyRepository: StrategyRepository;
  contentRepository: ContentRepository;
  toolRouter: ToolRouter;
  llm: LLMProvider;
  logger: Logger;
}

export interface AgentRunOutcome {
  runId: string;
  status: "completed" | "failed";
  error?: string;
}

/**
 * Executes the fixed Research -> Strategy -> ContentPlanner pipeline for
 * one run:
 *   resolve run (new or resumed) -> load account context once ->
 *   run each agent in order, feeding each agent's result forward via
 *   previousResults -> persist decisions/actions/domain rows for each
 *   stage (transactionally, idempotently) -> mark run complete.
 *
 * Persistence lives here, not in the agents (rule: agents never touch a
 * repository) and not in the caller (AgentRunService only starts/reads
 * runs) — this is the single place an AgentResult becomes database rows.
 */
export class AgentOrchestrator {
  constructor(
    private readonly deps: OrchestratorDependencies,
    private readonly agents: Agent[],
  ) {}

  /**
   * `options.runId` lets a caller (typically the BullMQ job processor)
   * resume/retry a specific run instead of always creating a new one — a
   * redelivered job for an already-completed run is a no-op, and a retry
   * of a partially-completed run will not duplicate rows already written,
   * because every persistence step below checks for existing rows first.
   */
  async executeRun(accountId: string, options: { runId?: string } = {}): Promise<AgentRunOutcome> {
    const { agentRunRepository, contextLoader, toolRouter, llm, logger } = this.deps;

    const run = options.runId
      ? await agentRunRepository.findById(options.runId)
      : await agentRunRepository.create(accountId);

    if (!run) throw new NotFoundError("AgentRun", options.runId!);

    if (run.status === "completed") {
      logger.info({ runId: run.id }, "agent_run.already_completed_skip");
      return { runId: run.id, status: "completed" };
    }

    await agentRunRepository.markRunning(run.id);
    logger.info({ runId: run.id, accountId }, "agent_run.started");

    try {
      const contextData = await contextLoader.load(accountId);
      const previousResults: Partial<Record<AgentName, AgentResult>> = {};
      let currentStrategyVersionId = contextData.currentStrategy?.versionId;

      for (const agent of this.agents) {
        const context: AgentContext = {
          ...contextData,
          runId: run.id,
          accountId,
          logger,
          llm,
          tools: toolRouter,
          previousResults,
        };

        const result = await agent.run(context);
        previousResults[agent.name] = result;

        if (agent.name === "research") {
          await this.persistResearchResult(run.id, accountId, result);
        } else if (agent.name === "strategy") {
          currentStrategyVersionId = await this.persistStrategyResult(run.id, contextData, result);
        } else if (agent.name === "content_planner") {
          await this.persistContentPlanResult(run.id, contextData.agentProfileId, result, currentStrategyVersionId);
        } else {
          await this.persistGenericResult(run.id, agent.name, result);
        }
      }

      await agentRunRepository.markFinished(run.id, "completed");
      logger.info({ runId: run.id }, "agent_run.completed");
      return { runId: run.id, status: "completed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await agentRunRepository.markFinished(run.id, "failed", message);
      logger.error({ runId: run.id, error: message }, "agent_run.failed");
      return { runId: run.id, status: "failed", error: message };
    }
  }

  /** Records every decision/action for a stage inside `tx`, returning the last decision's id (actions link to it). */
  private async recordDecisionsAndActions(
    tx: DrizzleClient,
    runId: string,
    agentName: string,
    result: AgentResult,
  ): Promise<void> {
    const runRepo = new AgentRunRepository(tx);
    let lastDecisionId: string | undefined;
    for (const decision of result.decisions) {
      const row = await runRepo.recordDecision({
        agentRunId: runId,
        agentName,
        decision: decision.decision,
        reason: decision.reason,
        metadata: decision.metadata,
      });
      lastDecisionId = row.id;
      this.deps.logger.info(
        { runId, agentName, decision: decision.decision, reason: decision.reason },
        "agent_run.decision",
      );
    }
    for (const action of result.actions) {
      await runRepo.recordAction({
        agentRunId: runId,
        agentDecisionId: lastDecisionId,
        actionType: action.actionType,
        status: action.status,
        payload: action.payload,
        result: action.result,
      });
    }
  }

  /** Fallback for any agent without a dedicated persistence step (e.g. future skeleton agents). */
  private async persistGenericResult(runId: string, agentName: string, result: AgentResult): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      await this.recordDecisionsAndActions(tx, runId, agentName, result);
    });
  }

  private async persistResearchResult(runId: string, accountId: string, result: AgentResult): Promise<void> {
    const topics = (result.data as { topics?: ResearchResult["topics"] } | undefined)?.topics ?? [];

    await this.deps.db.transaction(async (tx) => {
      await this.recordDecisionsAndActions(tx, runId, "research", result);

      const researchRepo = new ResearchRepository(tx);
      const existing = await researchRepo.listByRunId(runId);
      if (existing.length === 0 && topics.length > 0) {
        await researchRepo.createMany(
          topics.map((t) => ({
            socialAccountId: accountId,
            agentRunId: runId,
            topic: t.topic,
            relevanceScore: t.relevanceScore,
            audienceInterestScore: t.audienceInterestScore,
            competitionScore: t.competitionScore,
            rationale: t.rationale,
            sourceType: "mock",
          })),
        );
      }
    });
  }

  /** Returns the strategy version id now current for this profile (new or unchanged), for ContentPlanner traceability. */
  private async persistStrategyResult(
    runId: string,
    contextData: AgentContextData,
    result: AgentResult,
  ): Promise<string | undefined> {
    const data = result.data as (StrategyResult & { shouldUpdateStrategy: boolean }) | undefined;

    return this.deps.db.transaction(async (tx) => {
      await this.recordDecisionsAndActions(tx, runId, "strategy", result);

      if (!data?.shouldUpdateStrategy) {
        return contextData.currentStrategy?.versionId;
      }

      const strategyRepo = new StrategyRepository(tx);

      const existingVersion = await strategyRepo.findVersionByRunId(runId);
      if (existingVersion) return existingVersion.id;

      let strategy = (await strategyRepo.findByAgentProfileId(contextData.agentProfileId))[0];
      if (!strategy) {
        strategy = await strategyRepo.create({
          agentProfileId: contextData.agentProfileId,
          name: `${contextData.account.niche} strategy`,
        });
      }

      const latest = await strategyRepo.latestVersion(strategy.id);
      const nextVersionNumber = (latest?.versionNumber ?? 0) + 1;

      const version = await strategyRepo.createVersion({
        strategyId: strategy.id,
        versionNumber: nextVersionNumber,
        summary: data.reasoningSummary,
        content: {
          audience: data.audience,
          positioning: data.positioning,
          contentPillars: data.contentPillars,
          formats: data.formats,
          postingFrequencyPerWeek: data.postingFrequencyPerWeek,
        },
        createdBy: "strategy_agent",
        agentRunId: runId,
      });
      return version.id;
    });
  }

  private async persistContentPlanResult(
    runId: string,
    agentProfileId: string,
    result: AgentResult,
    strategyVersionId: string | undefined,
  ): Promise<void> {
    const ideas = (result.data as { ideas?: ContentPlanResult["ideas"] } | undefined)?.ideas ?? [];

    await this.deps.db.transaction(async (tx) => {
      await this.recordDecisionsAndActions(tx, runId, "content_planner", result);

      const contentRepo = new ContentRepository(tx);
      const existing = await contentRepo.listIdeasByRunId(runId);
      if (existing.length === 0 && ideas.length > 0) {
        await contentRepo.createIdeas(
          ideas.map((idea) => ({
            agentProfileId,
            agentRunId: runId,
            strategyVersionId,
            title: idea.title,
            description: idea.hook,
            format: idea.format,
            contentPillar: idea.contentPillar,
            targetAudience: idea.targetAudience,
            hook: idea.hook,
            objective: idea.objective,
            priorityScore: idea.priorityScore,
          })),
        );
      }
    });
  }
}
