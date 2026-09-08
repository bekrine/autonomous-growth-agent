import { AppError } from "@agent/shared";

/** The provider returned JSON that failed schema validation on every retry attempt. */
export class LLMValidationError extends AppError {
  constructor(schemaName: string, attempts: number, details?: unknown) {
    super(`LLM output for "${schemaName}" failed validation after ${attempts} attempt(s)`, {
      statusCode: 502,
      code: "LLM_VALIDATION_ERROR",
      details,
    });
  }
}

/** The provider request itself failed (network, timeout, rate limit) on every retry attempt. */
export class LLMRequestError extends AppError {
  constructor(message: string, attempts: number) {
    super(`LLM request failed after ${attempts} attempt(s): ${message}`, {
      statusCode: 502,
      code: "LLM_REQUEST_ERROR",
    });
  }
}
