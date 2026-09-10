import { AppError } from "@agent/shared";

/** ContentCreatorAgent/ReviewerAgent were invoked without the per-content context they require. */
export class MissingContentGenerationContextError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 500, code: "MISSING_CONTENT_GENERATION_CONTEXT" });
  }
}
