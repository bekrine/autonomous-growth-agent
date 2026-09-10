import type { ZodType } from "zod";
import { LLMRequestError, LLMValidationError } from "./errors.js";

export interface StructuredRetryOptions<T> {
  schema: ZodType<T>;
  schemaName: string;
  maxRetries: number;
  /**
   * Performs one raw generation attempt and returns the raw text response.
   * `feedback`, when set, is corrective guidance from the previous failed
   * attempt (invalid JSON or a schema violation) that the caller should
   * fold into the next request so the model can self-correct.
   */
  generate: (feedback?: string) => Promise<string>;
  /**
   * Reports why an attempt failed. Receives the schema-violation summary
   * (never the model's raw output) so a persistently-failing prompt/schema
   * mismatch is diagnosable from logs instead of surfacing as an opaque
   * "failed validation after N attempts".
   */
  onAttemptFailed?: (info: { attempt: number; kind: FailureKind; message: string }) => void;
}

type FailureKind = "request" | "parse" | "validation";

/**
 * Shared retry/validate loop used by every LLMProvider.generateStructured
 * implementation: call `generate`, parse the result as JSON, validate
 * against `schema`, and retry with corrective feedback on failure — up to
 * `maxRetries` attempts, never unbounded. Extracted so it's testable
 * without a real provider and so every provider retries identically.
 */
export async function generateStructuredWithRetry<T>(options: StructuredRetryOptions<T>): Promise<T> {
  const maxRetries = Math.max(1, options.maxRetries);
  let feedback: string | undefined;
  let lastKind: FailureKind = "request";
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let text: string;
    try {
      text = await options.generate(feedback);
    } catch (error) {
      lastKind = "request";
      lastError = error;
      feedback = undefined;
      options.onAttemptFailed?.({
        attempt,
        kind: "request",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      lastKind = "parse";
      lastError = error;
      feedback = "Your previous response was not valid JSON. Respond with ONLY valid JSON, no prose, no markdown fences.";
      options.onAttemptFailed?.({
        attempt,
        kind: "parse",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const result = options.schema.safeParse(parsed);
    if (result.success) return result.data;

    lastKind = "validation";
    lastError = result.error;
    // Only the field paths + violation reasons — never the model's raw output.
    const summary = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    feedback = `Your previous JSON response did not match the required schema: ${summary}. Respond again with ONLY corrected JSON.`;
    options.onAttemptFailed?.({ attempt, kind: "validation", message: summary });
  }

  if (lastKind === "request") {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new LLMRequestError(message, maxRetries);
  }
  throw new LLMValidationError(options.schemaName, maxRetries, lastError);
}
