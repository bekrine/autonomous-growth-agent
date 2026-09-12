import { defineConfig } from "vitest/config";

/**
 * Root test configuration.
 *
 * The default 5s per-test budget is too tight for this repo: most of the
 * meaningful tests are integration tests that hit a real Postgres, and several
 * also rasterize an image with sharp. Running them in parallel makes 5s a
 * source of flaky, misleading failures — a timeout surfaces as an unrelated
 * assertion ("expected 'publishing' to be 'failed'") because the work simply
 * had not finished.
 *
 * 30s is a ceiling, not a target: a genuinely hung test still fails, it just
 * no longer fails because the machine was busy.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
