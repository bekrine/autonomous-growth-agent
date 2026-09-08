import type { Logger } from "@agent/shared";
import type { LLMProvider } from "@agent/llm";
import type { AgentName } from "@agent/shared";
import type { ToolRouter } from "./tool-router.js";
import type { AgentContextData } from "./context/types.js";

/** One structured decision an agent made. No chain-of-thought — a concise label + reason. */
export interface AgentDecisionInput {
  decision: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/** One concrete effect the agent produced (usually via a tool call). */
export interface AgentActionInput {
  actionType: string;
  status: "pending" | "succeeded" | "failed";
  payload?: Record<string, unknown>;
  result?: unknown;
}

export interface AgentResult {
  decisions: AgentDecisionInput[];
  actions: AgentActionInput[];
  /** Arbitrary structured data passed forward to the next agent in the run. */
  data?: Record<string, unknown>;
}

/**
 * Full per-run context handed to every agent. `AgentContextData` (account,
 * goal, strategy, recent content/analytics, experiments, prior research,
 * policy flags) is assembled once by AgentContextLoader before the run
 * starts; the orchestrator merges it with the run-scoped fields below.
 * Agents never query a repository themselves — everything they need to
 * reason about is already here.
 */
export interface AgentContext extends AgentContextData {
  runId: string;
  accountId: string;
  logger: Logger;
  llm: LLMProvider;
  tools: ToolRouter;
  /** Results already produced earlier in this run, keyed by agent name. */
  previousResults: Partial<Record<AgentName, AgentResult>>;
}

/**
 * All concrete agents implement this. Agents must never query the database
 * or call a social-platform SDK directly — only through `context.tools`,
 * which enforces the policy layer.
 */
export interface Agent {
  readonly name: AgentName;
  run(context: AgentContext): Promise<AgentResult>;
}
