import { Router } from "express";
import { z } from "zod";
import { ContentRepository } from "@agent/database";
import type { AppDependencies } from "../config.js";
import { ContentService } from "../services/content.service.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { validate } from "../middleware/validate.js";

const createPostSchema = z.object({
  socialAccountId: z.string().uuid(),
  contentIdeaId: z.string().uuid().optional(),
  caption: z.string().optional(),
  mediaUrls: z.array(z.string().url()).optional(),
});

export function contentRoutes(deps: AppDependencies): Router {
  const router = Router();
  const service = new ContentService(new ContentRepository(deps.db));

  router.get(
    "/content",
    asyncHandler(async (_req, res) => {
      res.json(await service.listPosts());
    }),
  );

  router.post(
    "/content",
    validate("body", createPostSchema),
    asyncHandler(async (req, res) => {
      const post = await service.createPost(req.body);
      res.status(201).json(post);
    }),
  );

  return router;
}
