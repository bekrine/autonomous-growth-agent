import { Router } from "express";
import { z } from "zod";
import { SOCIAL_PLATFORMS } from "@agent/shared";
import type { AppDependencies } from "../config.js";
import { AccountService } from "../services/account.service.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { validate } from "../middleware/validate.js";

const createAccountSchema = z.object({
  userEmail: z.string().email(),
  platform: z.enum(SOCIAL_PLATFORMS),
  externalAccountId: z.string().min(1),
  displayName: z.string().min(1),
});

export function accountsRoutes(deps: AppDependencies): Router {
  const router = Router();
  const service = new AccountService(deps.agentSystem.repositories.socialAccountRepository);

  router.get("/accounts", asyncHandler(async (_req, res) => {
    res.json(await service.listAccounts());
  }));

  router.post(
    "/accounts",
    validate("body", createAccountSchema),
    asyncHandler(async (req, res) => {
      const account = await service.createAccount(req.body);
      res.status(201).json(account);
    }),
  );

  return router;
}
