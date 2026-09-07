import { Router } from "express";
import { sql } from "drizzle-orm";
import type { AppDependencies } from "../config.js";
import { asyncHandler } from "../middleware/async-handler.js";

const API_VERSION = "0.1.0";

export function healthRoutes(deps: AppDependencies): Router {
  const router = Router();

  router.get("/health", asyncHandler(async (_req, res) => {
    let databaseOk = false;
    let redisOk = false;

    try {
      await deps.db.execute(sql`select 1`);
      databaseOk = true;
    } catch {
      databaseOk = false;
    }

    try {
      const pong = await deps.redis.ping();
      redisOk = pong === "PONG";
    } catch {
      redisOk = false;
    }

    const status = databaseOk && redisOk ? "ok" : "degraded";
    res.status(status === "ok" ? 200 : 503).json({
      status,
      database: databaseOk ? "up" : "down",
      redis: redisOk ? "up" : "down",
      timestamp: new Date().toISOString(),
    });
  }));

  router.get("/version", (_req, res) => {
    res.json({ version: API_VERSION, env: deps.env.NODE_ENV });
  });

  return router;
}
