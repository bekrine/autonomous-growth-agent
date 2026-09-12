import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { createLogger } from "@agent/shared";
import { CONTENT_PUBLISHED_EVENT } from "@agent/shared";
import { createAnalyticsProcessor } from "../analytics-processor.js";

const logger = createLogger({ name: "test", level: "silent" });

function fakeService(overrides: Record<string, unknown> = {}) {
  return {
    schedulePostCollection: vi.fn(async () => ({ id: "state-1" })),
    collectForPost: vi.fn(async (id: string) => ({ contentPostId: id, status: "up_to_date" as const })),
    findPostsDueForCollection: vi.fn(async () => []),
    collectAccountSnapshot: vi.fn(async () => ({ contentPostId: "acct", status: "up_to_date" as const })),
    ...overrides,
  };
}

function job(name: string, data: unknown): Job {
  return { id: "job-1", name, data } as unknown as Job;
}

describe("analytics processor", () => {
  it("schedules collection when a post is published", async () => {
    const service = fakeService();
    const process = createAnalyticsProcessor(service as never, logger);

    await process(
      job(CONTENT_PUBLISHED_EVENT, {
        contentPostId: "post-1",
        socialAccountId: "acct-1",
        externalPostId: "1790",
        platform: "instagram",
        publishedAt: "2026-09-01T10:00:00.000Z",
      }),
    );

    expect(service.schedulePostCollection).toHaveBeenCalledWith({
      contentPostId: "post-1",
      socialAccountId: "acct-1",
      externalPostId: "1790",
      platform: "instagram",
      publishedAt: new Date("2026-09-01T10:00:00.000Z"),
    });
    // Publishing must not trigger an immediate collection — the first window
    // is an hour out, and collecting instantly would waste a snapshot.
    expect(service.collectForPost).not.toHaveBeenCalled();
  });

  it("delegates a targeted collection to the service", async () => {
    const service = fakeService();
    const process = createAnalyticsProcessor(service as never, logger);

    const result = await process(job("collect-analytics", { contentPostId: "post-2", collectionWindow: "daily" }));

    expect(service.collectForPost).toHaveBeenCalledWith("post-2", { window: "daily" });
    expect(result).toMatchObject({ contentPostId: "post-2", status: "up_to_date" });
  });

  it("sweeps only the posts the service reports as due", async () => {
    const service = fakeService({
      findPostsDueForCollection: vi.fn(async () => [{ contentPostId: "a" }, { contentPostId: "b" }]),
    });
    const process = createAnalyticsProcessor(service as never, logger);

    const result = await process(job("collect-analytics", {}));

    expect(service.collectForPost).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ collected: 2 });
  });

  it("does not throw on a failed collection — the service already decided about retrying", async () => {
    const service = fakeService({
      collectForPost: vi.fn(async () => ({ contentPostId: "post-3", status: "failed" as const, reason: "denied" })),
    });
    const process = createAnalyticsProcessor(service as never, logger);

    // Throwing here would add a second, uncoordinated retry loop on top of
    // the service's own bounded scheduling.
    await expect(process(job("collect-analytics", { contentPostId: "post-3" }))).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("contains no analytics logic of its own", async () => {
    const service = fakeService();
    const process = createAnalyticsProcessor(service as never, logger);

    await process(job("collect-analytics", { contentPostId: "post-4" }));

    // Every code path defers to the service; the worker is plumbing.
    expect(service.collectForPost).toHaveBeenCalledOnce();
  });
});
