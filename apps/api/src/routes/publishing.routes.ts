import { Router } from "express";
import { z } from "zod";
import type { AppDependencies } from "../config.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { validate } from "../middleware/validate.js";

const idParamsSchema = z.object({ id: z.string().uuid() });

const publishBodySchema = z.object({
  socialConnectionId: z.string().uuid(),
});

const scheduleBodySchema = z.object({
  socialConnectionId: z.string().uuid(),
  scheduledFor: z.string().datetime(),
});

/**
 * Manual publishing and scheduling. `:id` is the content **post** id.
 *
 * Both routes only ever enqueue — the Meta call happens in the publishing
 * worker, so the HTTP request never blocks on Instagram's asynchronous
 * media processing. A denial (policy, kill switch, unconnected account)
 * comes back as 409 with a structured reason rather than an exception.
 */
export function publishingRoutes(deps: AppDependencies): Router {
  const router = Router();
  const service = deps.agentSystem.publishingService;

  router.post(
    "/content/:id/publish",
    validate("params", idParamsSchema),
    validate("body", publishBodySchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
      const { socialConnectionId } = req.body as z.infer<typeof publishBodySchema>;

      const result = await service.enqueue({
        contentPostId: id,
        socialConnectionId,
        initiatedBy: "human",
      });

      if (!result.accepted) {
        res.status(409).json({ allowed: false, reason: result.reason, ...result });
        return;
      }
      res.status(202).json(result);
    }),
  );

  router.post(
    "/content/:id/schedule",
    validate("params", idParamsSchema),
    validate("body", scheduleBodySchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
      const { socialConnectionId, scheduledFor } = req.body as z.infer<typeof scheduleBodySchema>;

      const result = await service.enqueue({
        contentPostId: id,
        socialConnectionId,
        scheduledFor: new Date(scheduledFor),
        initiatedBy: "human",
      });

      if (!result.accepted) {
        res.status(409).json({ allowed: false, reason: result.reason, ...result });
        return;
      }
      res.status(202).json(result);
    }),
  );

  router.get(
    "/publishing-jobs",
    asyncHandler(async (_req, res) => {
      res.json(await service.listJobs());
    }),
  );

  router.get(
    "/publishing-jobs/:id",
    validate("params", idParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
      res.json(await service.getJob(id));
    }),
  );

  router.post(
    "/publishing-jobs/:id/cancel",
    validate("params", idParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
      const result = await service.cancel(id);

      if (!result.cancelled) {
        res.status(409).json(result);
        return;
      }
      res.json(result);
    }),
  );

  return router;
}
