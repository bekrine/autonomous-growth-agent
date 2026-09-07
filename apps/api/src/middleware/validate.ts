import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { ValidationError } from "@agent/shared";

type RequestPart = "body" | "query" | "params";

/** Generic request-validation middleware backed by a Zod schema. */
export function validate(part: RequestPart, schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      next(new ValidationError(`Invalid ${part}`, result.error.flatten()));
      return;
    }
    req[part] = result.data;
    next();
  };
}
