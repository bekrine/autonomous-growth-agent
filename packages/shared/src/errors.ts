/**
 * Base class for all errors that are intentionally raised by the domain
 * (as opposed to unexpected exceptions). Carries an HTTP-mappable status
 * code and a machine-readable code so the centralized error handler can
 * respond consistently without inspecting error messages.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options: { statusCode?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? "INTERNAL_ERROR";
    this.details = options.details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { statusCode: 400, code: "VALIDATION_ERROR", details });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(id ? `${resource} not found: ${id}` : `${resource} not found`, {
      statusCode: 404,
      code: "NOT_FOUND",
    });
  }
}

export class PolicyDeniedError extends AppError {
  constructor(reason: string) {
    super(`Action denied by policy: ${reason}`, { statusCode: 403, code: "POLICY_DENIED" });
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 409, code: "CONFLICT" });
  }
}
