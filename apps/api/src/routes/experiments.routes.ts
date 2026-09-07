import { Router } from "express";
import { z } from "zod";
import { ExperimentRepository } from "@agent/database";
import type { AppDependencies } from "../config.js";
import { ExperimentService } from "../services/experiment.service.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { validate } from "../middleware/validate.js";

const accountIdParamsSchema = z.object({ accountId: z.string().uuid() });

export function experimentsRoutes(deps: AppDependencies): Router {
  const router = Router();
  const service = new ExperimentService(new ExperimentRepository(deps.db));

  router.get(
    "/experiments/:accountId",
    validate("params", accountIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params as unknown as z.infer<typeof accountIdParamsSchema>;
      res.json(await service.getForAccount(accountId));
    }),
  );

  return router;
}
