import { createAppDependencies } from "./config.js";
import { createApp } from "./app.js";
import { closeDatabase } from "@agent/database";

async function main() {
  const deps = createAppDependencies();
  const app = createApp(deps);

  const server = app.listen(deps.env.PORT, () => {
    deps.logger.info({ port: deps.env.PORT }, "api.listening");
  });

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info({ signal }, "api.shutting_down");

    server.close(async () => {
      await Promise.allSettled([closeDatabase(), deps.redis.quit()]);
      deps.logger.info("api.shutdown_complete");
      process.exit(0);
    });

    // Force-exit if graceful shutdown hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start API server:", error);
  process.exit(1);
});
