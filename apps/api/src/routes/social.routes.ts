import { Router } from "express";
import { z } from "zod";
import type { AppDependencies } from "../config.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { validate } from "../middleware/validate.js";

const connectQuerySchema = z.object({ accountId: z.string().uuid() });
const statusQuerySchema = z.object({ accountId: z.string().uuid() });
const listQuerySchema = z.object({ accountId: z.string().uuid().optional() });
const idParamsSchema = z.object({ id: z.string().uuid() });

/**
 * Instagram OAuth + connection management.
 *
 * No route here ever returns an access token: connections are read through
 * the repository's "safe" projection, which omits the encrypted token
 * columns entirely.
 */
export function socialRoutes(deps: AppDependencies): Router {
  const router = Router();
  const service = deps.instagramAuthService;

  /** Starts the flow. Returns the Meta consent URL for the browser to visit. */
  router.get(
    "/social/instagram/connect",
    validate("query", connectQuerySchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.query as unknown as z.infer<typeof connectQuerySchema>;
      const { authorizationUrl } = await service.beginConnect(accountId);

      // `?redirect=1` sends the browser straight to Meta; otherwise return the
      // URL so a SPA can decide how to navigate.
      if (req.query.redirect === "1") {
        res.redirect(authorizationUrl);
        return;
      }
      res.json({ authorizationUrl });
    }),
  );

  /**
   * Meta redirects the browser here. Deliberately NOT schema-validated as a
   * whole: Meta may send either (code, state) or (error, error_description),
   * and the service decides what is acceptable.
   */
  router.get(
    "/social/instagram/callback",
    asyncHandler(async (req, res) => {
      const result = await service.completeConnect({
        code: typeof req.query.code === "string" ? req.query.code : undefined,
        state: typeof req.query.state === "string" ? req.query.state : undefined,
        error: typeof req.query.error === "string" ? req.query.error : undefined,
        errorDescription:
          typeof req.query.error_description === "string" ? req.query.error_description : undefined,
      });

      // Land the user back on the dashboard rather than showing raw JSON.
      const target = deps.env.DASHBOARD_URL
        ? `${deps.env.DASHBOARD_URL}/social-accounts?connected=instagram`
        : null;
      if (target) {
        res.redirect(target);
        return;
      }
      res.json(result);
    }),
  );

  router.get(
    "/social/instagram/status",
    validate("query", statusQuerySchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.query as unknown as z.infer<typeof statusQuerySchema>;
      res.json(await service.getStatus(accountId));
    }),
  );

  router.get(
    "/social/connections",
    validate("query", listQuerySchema),
    asyncHandler(async (req, res) => {
      const { accountId } = req.query as unknown as z.infer<typeof listQuerySchema>;
      res.json(await service.listConnections(accountId));
    }),
  );

  router.delete(
    "/social/connections/:id",
    validate("params", idParamsSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as z.infer<typeof idParamsSchema>;
      await service.disconnect(id);
      res.status(204).send();
    }),
  );

  return router;
}
