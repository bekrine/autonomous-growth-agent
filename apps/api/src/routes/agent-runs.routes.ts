import { Router } from "express";
import { z } from "zod";
import type { AppDependencies } from "../config.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { validate } from "../middleware/validate.js";

const createRunSchema = z.object({
  accountId: z.string().uuid(),
});

const runIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export function agentRunsRoutes(deps: AppDependencies): Router {
  const router = Router();
  const service = deps.agentSystem.agentRunService;

  router.get(
    "/agent/runs",
    asyncHandler(async (_req, res) => {
      res.json(await service.listRuns());
    }),
  );

  router.post(
    "/agent/runs",
    validate("body", createRunSchema),
    asyncHandler(async (req, res) => {
      const outcome = await service.startRun(req.body.accountId);
      res.status(200).json(outcome);
    }),
  );

  router.post(
    "/agent/runs/queue",
    validate("body", createRunSchema),
    asyncHandler(async (req, res) => {
      const { jobId } = await deps.agentQueueProducer.enqueueRun(req.body.accountId);
      res.status(202).json({ status: "queued", jobId });
    }),
  );

  router.get(
    "/agent/runs/:id",
    validate("params", runIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof runIdParamsSchema>;
      res.json(await service.getRun(id));
    }),
  );

  return router;
}
