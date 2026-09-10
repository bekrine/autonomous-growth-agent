import express, { type Express } from "express";
import cors from "cors";
import type { AppDependencies } from "./config.js";
import { createErrorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { healthRoutes } from "./routes/health.routes.js";
import { accountsRoutes } from "./routes/accounts.routes.js";
import { strategiesRoutes } from "./routes/strategies.routes.js";
import { contentRoutes } from "./routes/content.routes.js";
import { contentGenerationRoutes } from "./routes/content-generation.routes.js";
import { socialRoutes } from "./routes/social.routes.js";
import { publishingRoutes } from "./routes/publishing.routes.js";
import { analyticsRoutes } from "./routes/analytics.routes.js";
import { experimentsRoutes } from "./routes/experiments.routes.js";
import { agentRunsRoutes } from "./routes/agent-runs.routes.js";

/** Pure app construction (no listen()) so tests can exercise it with supertest. */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());
  // Local-disk asset storage (packages/media's LocalObjectStorage) served
  // statically — swap for a real STORAGE_* provider's CDN URL later
  // without any route changes on the consuming side.
  app.use("/media", express.static(deps.env.STORAGE_LOCAL_DIR));

  app.use("/api", healthRoutes(deps));
  app.use("/api", accountsRoutes(deps));
  app.use("/api", strategiesRoutes(deps));
  app.use("/api", contentRoutes(deps));
  app.use("/api", contentGenerationRoutes(deps));
  app.use("/api", socialRoutes(deps));
  app.use("/api", publishingRoutes(deps));
  app.use("/api", analyticsRoutes(deps));
  app.use("/api", experimentsRoutes(deps));
  app.use("/api", agentRunsRoutes(deps));

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));

  return app;
}
