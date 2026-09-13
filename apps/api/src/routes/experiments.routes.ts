import { Router } from "express";
import { z } from "zod";
import { EXPERIMENT_METRICS, EXPERIMENT_VARIABLES } from "@agent/agent-core";
import type { AppDependencies } from "../config.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { validate } from "../middleware/validate.js";

const accountIdParamsSchema = z.object({ accountId: z.string().uuid() });
const experimentIdParamsSchema = z.object({ id: z.string().uuid() });

/**
 * The API mirrors the domain's own constraints so obviously-invalid input is
 * rejected before it reaches the service. The service still re-validates —
 * this is a convenience, not the authority.
 */
const variantSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["control", "variant"]),
  variableValue: z.string().min(1),
  description: z.string().optional(),
  fixedDimensions: z.record(z.string().nullable()).optional(),
});

const createExperimentSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().min(1),
  hypothesis: z.string().min(1),
  variable: z.enum(EXPERIMENT_VARIABLES),
  primaryMetric: z.enum(EXPERIMENT_METRICS),
  secondaryMetrics: z.array(z.enum(EXPERIMENT_METRICS)).optional(),
  variants: z.array(variantSchema).min(2),
  minSamplesPerVariant: z.number().int().min(1).optional(),
  observationWindowHours: z.number().int().min(1).optional(),
  maxDurationDays: z.number().int().min(1).optional(),
  minRelativeLift: z.number().min(0).optional(),
  /** Opt-in acknowledgement that more than one thing is being varied. */
  allowMultiFactor: z.boolean().optional(),
});

const reasonSchema = z.object({ reason: z.string().optional() });

const attachContentSchema = z.object({
  variantId: z.string().uuid(),
  contentPostId: z.string().uuid(),
});

export function experimentsRoutes(deps: AppDependencies): Router {
  const router = Router();
  const service = deps.agentSystem.experimentService;

  /** Supported variables and metrics, so the dashboard never hard-codes them. */
  router.get(
    "/experiments/config",
    asyncHandler(async (_req, res) => {
      res.json({
        variables: EXPERIMENT_VARIABLES,
        metrics: EXPERIMENT_METRICS,
      });
    }),
  );

  router.post(
    "/experiments",
    validate("body", createExperimentSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof createExperimentSchema>;
      const result = await service.createExperiment(
        body.accountId,
        {
          name: body.name,
          hypothesis: body.hypothesis,
          variable: body.variable,
          primaryMetric: body.primaryMetric,
          secondaryMetrics: body.secondaryMetrics,
          variants: body.variants,
          minSamplesPerVariant: body.minSamplesPerVariant,
          observationWindowHours: body.observationWindowHours,
          maxDurationDays: body.maxDurationDays,
          minRelativeLift: body.minRelativeLift,
        },
        { allowMultiFactor: body.allowMultiFactor },
      );

      // 422 with structured issues, not a generic 400: the caller needs to know
      // which rule the design broke.
      res.status(result.created ? 201 : 422).json(result);
    }),
  );

  router.get(
    "/experiments/:id/results",
    validate("params", experimentIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      const { evaluations } = await service.getExperiment(id);
      res.json(evaluations);
    }),
  );

  router.get(
    "/experiments/:id/variants",
    validate("params", experimentIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      const { variants } = await service.getExperiment(id);
      res.json(variants);
    }),
  );

  router.get(
    "/experiments/:id/progress",
    validate("params", experimentIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      res.json(await service.getProgress(id));
    }),
  );

  router.get(
    "/experiments/:id/schedule",
    validate("params", experimentIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      res.json(await service.planSchedule(id));
    }),
  );

  router.post(
    "/experiments/:id/ready",
    validate("params", experimentIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      res.json(await service.markReady(id));
    }),
  );

  router.post(
    "/experiments/:id/start",
    validate("params", experimentIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      res.json(await service.start(id));
    }),
  );

  router.post(
    "/experiments/:id/pause",
    validate("params", experimentIdParamsSchema),
    validate("body", reasonSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      res.json(await service.pause(id, (req.body as z.infer<typeof reasonSchema>).reason));
    }),
  );

  router.post(
    "/experiments/:id/cancel",
    validate("params", experimentIdParamsSchema),
    validate("body", reasonSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      res.json(await service.cancel(id, (req.body as z.infer<typeof reasonSchema>).reason));
    }),
  );

  router.post(
    "/experiments/:id/content",
    validate("params", experimentIdParamsSchema),
    validate("body", attachContentSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      const body = req.body as z.infer<typeof attachContentSchema>;
      res.json(await service.attachContent(id, body.variantId, body.contentPostId));
    }),
  );

  router.post(
    "/experiments/:id/evaluate",
    validate("params", experimentIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      const { evaluation, created } = await service.evaluate(id);
      res.json({ ...evaluation, created });
    }),
  );

  /** ExperimentAgent proposal from current analytics — reviewed before it is created. */
  router.post(
    "/experiments/propose",
    validate("body", z.object({ accountId: z.string().uuid() })),
    asyncHandler(async (req, res) => {
      const { accountId } = req.body as { accountId: string };
      res.json(await deps.agentSystem.agentRunService.proposeExperiment(accountId));
    }),
  );

  router.post(
    "/experiments/:id/summarize",
    validate("params", experimentIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      res.json(await deps.agentSystem.agentRunService.summarizeExperiment(id));
    }),
  );

  /** Detail. Registered after the more specific /experiments/:id/* routes. */
  router.get(
    "/experiments/detail/:id",
    validate("params", experimentIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof experimentIdParamsSchema>;
      res.json(await service.getExperiment(id));
    }),
  );

  /**
   * Phase 1 route shape (`/experiments/:accountId`). Kept last so it cannot
   * shadow the `/experiments/:id/...` routes above.
   */
  router.get(
    "/experiments/:accountId",
    validate("params", accountIdParamsSchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params as unknown as z.infer<typeof accountIdParamsSchema>;
      res.json(await service.listForAccount(accountId));
    }),
  );

  return router;
}
