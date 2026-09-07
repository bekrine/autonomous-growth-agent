import { Router } from "express";
import { z } from "zod";
import { AnalyticsRepository } from "@agent/database";
import type { AppDependencies } from "../config.js";
import { AnalyticsService } from "../services/analytics.service.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { validate } from "../middleware/validate.js";

const accountIdParamsSchema = z.object({ accountId: z.string().uuid() });

export function analyticsRoutes(deps: AppDependencies): Router {
  const router = Router();
  const service = new AnalyticsService(new AnalyticsRepository(deps.db));

  router.get(
    "/analytics/:accountId",
    validate("params", accountIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params as unknown as z.infer<typeof accountIdParamsSchema>;
      res.json(await service.getForAccount(accountId));
    }),
  );

  return router;
}
