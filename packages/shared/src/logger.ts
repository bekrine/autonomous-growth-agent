import pino from "pino";

export interface LoggerOptions {
  name: string;
  level?: string;
}

/**
 * Structured logger shared by every process. Agent-related logs should
 * always carry runId/accountId/agentName so runs can be reconstructed from
 * log aggregation alone. Never log chain-of-thought or raw prompts here —
 * only concise decision summaries and structured metadata.
 */
export function createLogger(options: LoggerOptions) {
  return pino({
    name: options.name,
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
