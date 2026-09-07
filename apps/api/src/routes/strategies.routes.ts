import { Router } from "express";
import { z } from "zod";
import type { AppDependencies } from "../config.js";
import { StrategyService } from "../services/strategy.service.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { validate } from "../middleware/validate.js";

const createStrategySchema = z.object({
  agentProfileId: z.string().uuid(),
  name: z.string().min(1),
});

const accountIdParamsSchema = z.object({ accountId: z.string().uuid() });

export function strategiesRoutes(deps: AppDependencies): Router {
  const router = Router();
  const service = new StrategyService(deps.agentSystem.repositories.strategyRepository, deps.db);

  router.get(
    "/strategies/:accountId",
    validate("params", accountIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params as unknown as z.infer<typeof accountIdParamsSchema>;
      res.json(await service.getForAccount(accountId));
    }),
  );

  router.post(
    "/strategies",
    validate("body", createStrategySchema),
    asyncHandler(async (req, res) => {
      const strategy = await service.createStrategy(req.body);
      res.status(201).json(strategy);
    }),
  );

  return router;
}
