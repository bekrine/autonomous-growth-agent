import type { AgentRunRepository } from "@agent/database";
import type { Logger } from "@agent/shared";
import type { LLMProvider } from "@agent/llm";
import type { Agent, AgentContext, AgentResult } from "./types.js";
import type { ToolRouter } from "./tool-router.js";
import type { AgentName } from "@agent/shared";

export interface OrchestratorDependencies {
  agentRunRepository: AgentRunRepository;
  toolRouter: ToolRouter;
  llm: LLMProvider;
  logger: Logger;
}

/**
 * Executes a fixed sequence of agents for one run:
 *   create run -> load account context -> run each agent in order ->
 *   persist each decision/action -> mark run complete.
 * This is intentionally simple (no branching/replanning yet) — the
 * abstractions (Agent, AgentContext, ToolRouter) are what make richer
 * orchestration possible later without a rewrite.
 */
export class AgentOrchestrator {
  constructor(
    private readonly deps: OrchestratorDependencies,
    private readonly agents: Agent[],
  ) {}

  async executeRun(accountId: string): Promise<{ runId: string; status: "completed" | "failed" }> {
    const { agentRunRepository, toolRouter, llm, logger } = this.deps;

    const run = await agentRunRepository.create(accountId);
    await agentRunRepository.markRunning(run.id);
    logger.info({ runId: run.id, accountId }, "agent_run.started");

    const previousResults: Partial<Record<AgentName, AgentResult>> = {};

    try {
      for (const agent of this.agents) {
        const context: AgentContext = {
          runId: run.id,
          accountId,
          logger,
          llm,
          tools: toolRouter,
          previousResults,
        };

        const result = await agent.run(context);
        previousResults[agent.name] = result;

        let lastDecisionId: string | undefined;
        for (const decision of result.decisions) {
          const decisionRow = await agentRunRepository.recordDecision({
            agentRunId: run.id,
            agentName: agent.name,
            decision: decision.decision,
            reason: decision.reason,
            metadata: decision.metadata,
          });
          lastDecisionId = decisionRow.id;

          logger.info(
            { runId: run.id, agentName: agent.name, decision: decision.decision, reason: decision.reason },
            "agent_run.decision",
          );
        }

        for (const action of result.actions) {
          await agentRunRepository.recordAction({
            agentRunId: run.id,
            agentDecisionId: lastDecisionId,
            actionType: action.actionType,
            status: action.status,
            payload: action.payload,
            result: action.result,
          });
        }
      }

      await agentRunRepository.markFinished(run.id, "completed");
      logger.info({ runId: run.id }, "agent_run.completed");
      return { runId: run.id, status: "completed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await agentRunRepository.markFinished(run.id, "failed", message);
      logger.error({ runId: run.id, error: message }, "agent_run.failed");
      return { runId: run.id, status: "failed" };
    }
  }
}
