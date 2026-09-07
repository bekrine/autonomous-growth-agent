import type { Logger } from "@agent/shared";
import type { LLMProvider } from "@agent/llm";
import type { AgentName } from "@agent/shared";
import type { ToolRouter } from "./tool-router.js";

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

export interface AgentContext {
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
