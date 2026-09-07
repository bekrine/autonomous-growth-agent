import type { NextFunction, Request, Response } from "express";
import { AppError } from "@agent/shared";
import type { Logger } from "@agent/shared";

/**
 * Centralized error handler — the only place that turns a thrown error
 * into an HTTP response. Route handlers must never format error responses
 * themselves; they just throw or call next(error).
 */
export function createErrorHandler(logger: Logger) {
  return function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        logger.error({ err, path: req.path }, "request.error");
      }
      res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }

    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, path: req.path }, "request.unhandled_error");
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message } });
  };
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `Route not found: ${req.method} ${req.path}` } });
}
