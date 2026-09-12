import { Router } from "express";
import { z } from "zod";
import { AnalyticsRepository } from "@agent/database";
import type { AppDependencies } from "../config.js";
import { AnalyticsQueryService } from "../services/analytics-query.service.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { validate } from "../middleware/validate.js";

const accountIdParamsSchema = z.object({ accountId: z.string().uuid() });
const contentIdParamsSchema = z.object({ contentId: z.string().uuid() });
const topPostsQuerySchema = z.object({
  sortBy: z
    // Kept in step with the metrics actually collected — a metric that can be
    // measured but not sorted by is a dead end for the dashboard.
    .enum([
      "reach",
      "views",
      "likes",
      "comments",
      "shares",
      "saves",
      "follows",
      "total_interactions",
      "profile_views",
      "engagement_rate",
      "share_rate",
      "save_rate",
      "performance_score",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function analyticsRoutes(deps: AppDependencies): Router {
  const router = Router();
  const service = new AnalyticsQueryService(new AnalyticsRepository(deps.db), deps.agentSystem.analyticsService);

  /** Phase 1 route, kept so existing callers don't break. */
  router.get(
    "/analytics/:accountId",
    validate("params", accountIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params as unknown as z.infer<typeof accountIdParamsSchema>;
      res.json(await service.getForAccount(accountId));
    }),
  );

  router.get(
    "/analytics/accounts/:accountId/overview",
    validate("params", accountIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params as unknown as z.infer<typeof accountIdParamsSchema>;
      res.json(await service.getOverview(accountId));
    }),
  );

  router.get(
    "/analytics/accounts/:accountId/posts",
    validate("params", accountIdParamsSchema),
    validate("query", topPostsQuerySchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params as unknown as z.infer<typeof accountIdParamsSchema>;
      const { sortBy, limit } = req.query as unknown as z.infer<typeof topPostsQuerySchema>;
      res.json(await service.getTopPosts(accountId, { sortBy, limit }));
    }),
  );

  router.get(
    "/analytics/accounts/:accountId/growth",
    validate("params", accountIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params as unknown as z.infer<typeof accountIdParamsSchema>;
      res.json(await service.getGrowth(accountId));
    }),
  );

  router.get(
    "/analytics/accounts/:accountId/insights",
    validate("params", accountIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params as unknown as z.infer<typeof accountIdParamsSchema>;
      res.json(await service.getInsights(accountId));
    }),
  );

  router.get(
    "/analytics/posts/:contentId",
    validate("params", contentIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { contentId } = req.params as unknown as z.infer<typeof contentIdParamsSchema>;
      res.json(await service.getPostAnalytics(contentId));
    }),
  );

  /**
   * Manual collection trigger for operators and the smoke test. Collection
   * normally happens on the worker's schedule — this does not bypass it, it
   * calls the same service method.
   */
  router.post(
    "/analytics/posts/:contentId/collect",
    validate("params", contentIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { contentId } = req.params as unknown as z.infer<typeof contentIdParamsSchema>;
      const result = await deps.agentSystem.analyticsService.collectForPost(contentId, {
        window: typeof req.body?.window === "string" ? req.body.window : undefined,
      });
      res.status(result.status === "failed" ? 502 : 200).json(result);
    }),
  );

  router.post(
    "/analytics/accounts/:accountId/collect",
    validate("params", accountIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params as unknown as z.infer<typeof accountIdParamsSchema>;
      const result = await deps.agentSystem.analyticsService.collectAccountSnapshot(accountId);
      res.status(result.status === "failed" ? 502 : 200).json(result);
    }),
  );

  /**
   * Runs the AnalyticsAgent over what has already been measured. Separate from
   * collection on purpose: collection is cheap deterministic arithmetic that
   * runs on a schedule, interpretation costs an LLM call and runs on request.
   */
  router.post(
    "/analytics/accounts/:accountId/analyze",
    validate("params", accountIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params as unknown as z.infer<typeof accountIdParamsSchema>;
      res.json(await deps.agentSystem.agentRunService.analyzePerformance(accountId));
    }),
  );

  return router;
}
