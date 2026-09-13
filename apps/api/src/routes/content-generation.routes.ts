import { Router } from "express";
import { z } from "zod";
import type { AppDependencies } from "../config.js";
import { ContentGenerationService } from "../services/content-generation.service.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { validate } from "../middleware/validate.js";

const uuidParamSchema = z.object({ id: z.string().uuid() });

/**
 * `:id` means the content **idea** id for /generate and /generate/queue
 * (that's the natural starting point — pick an idea, then generate), and
 * the content **post** id for every other route (the post returned by
 * /generate is what you read back afterward). Documented here since the
 * param name is shared but its referent isn't.
 */
export function contentGenerationRoutes(deps: AppDependencies): Router {
  const router = Router();
  const service = new ContentGenerationService(
    deps.agentSystem.agentRunService,
    deps.agentSystem.repositories.contentRepository,
    deps.agentSystem.repositories.agentProfileRepository,
  );

  router.post(
    "/content/:id/generate",
    validate("params", uuidParamSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.status(200).json(await service.generate(id));
    }),
  );

  router.post(
    "/content/:id/generate/queue",
    validate("params", uuidParamSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      const accountId = await service.resolveAccountIdForIdea(id);
      const { jobId } = await deps.contentQueueProducer.enqueueGeneration(accountId, id);
      res.status(202).json({ status: "queued", jobId });
    }),
  );

  /**
   * Progress lookup for queued generation. Registered before `/content/:id`
   * so the literal path segment is matched first.
   */
  router.get(
    "/content/by-idea/:ideaId",
    validate("params", z.object({ ideaId: z.string().uuid() })),
    asyncHandler(async (req, res) => {
      const { ideaId } = req.params as unknown as { ideaId: string };
      const content = await service.getContentForIdea(ideaId);
      // 204 rather than 404: "not built yet" is an expected state while a
      // queued job is still running, not an error the caller should react to.
      if (!content) {
        res.status(204).end();
        return;
      }
      res.json(content);
    }),
  );

  router.get(
    "/content/:id",
    validate("params", uuidParamSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.json(await service.getContent(id));
    }),
  );

  router.get(
    "/content/:id/versions",
    validate("params", uuidParamSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.json(await service.getVersions(id));
    }),
  );

  router.post(
    "/content/:id/review",
    validate("params", uuidParamSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof uuidParamSchema>;
      res.json(await service.getLatestReview(id));
    }),
  );

  return router;
}
