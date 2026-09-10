import { describe, expect, it, vi } from "vitest";
import { InstagramAdapter } from "../adapters/instagram/instagram-adapter.js";
import { PublishingError, type PublishPostRequest } from "../publishing-types.js";

/** Builds a fetch stub that answers Graph API calls from a scripted map. */
function createFetchStub(handlers: {
  createContainer?: () => unknown;
  status?: () => unknown;
  publish?: () => unknown;
  failNext?: { status: number; body: unknown };
}) {
  const calls: { url: string; method: string; body?: string }[] = [];

  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });

    if (handlers.failNext) {
      const { status, body: errBody } = handlers.failNext;
      return new Response(JSON.stringify(errBody), { status });
    }
    if (url.includes("/media_publish")) {
      return new Response(JSON.stringify(handlers.publish?.() ?? { id: "ig_media_123" }), { status: 200 });
    }
    if (url.includes("fields=status_code")) {
      return new Response(JSON.stringify(handlers.status?.() ?? { status_code: "FINISHED" }), { status: 200 });
    }
    return new Response(JSON.stringify(handlers.createContainer?.() ?? { id: "container_1" }), { status: 200 });
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function baseRequest(overrides: Partial<PublishPostRequest> = {}): PublishPostRequest {
  return {
    platformAccountId: "17841400000000000",
    accessToken: "PAGE_TOKEN",
    kind: "image",
    caption: "hello world",
    media: [{ kind: "image", url: "https://cdn.example.com/a.jpg", mimeType: "image/jpeg" }],
    ...overrides,
  };
}

function makeAdapter(fetchImpl: typeof fetch) {
  return new InstagramAdapter({
    apiVersion: "v21.0",
    host: "https://graph.facebook.com",
    fetchImpl,
    pollIntervalMs: 0,
    maxPollAttempts: 3,
  });
}

describe("InstagramAdapter.publish", () => {
  it("creates a container, waits for FINISHED, then publishes", async () => {
    const { impl, calls } = createFetchStub({});
    const result = await makeAdapter(impl).publish(baseRequest());

    expect(result.externalPostId).toBe("ig_media_123");
    expect(result.externalContainerId).toBe("container_1");

    expect(calls[0].url).toContain("/v21.0/17841400000000000/media");
    expect(calls[0].body).toContain("image_url=");
    expect(calls[1].url).toContain("fields=status_code");
    expect(calls[2].url).toContain("/media_publish");
    expect(calls[2].body).toContain("creation_id=container_1");
  });

  it("reports the container id before publishing so a crash is resumable", async () => {
    const { impl } = createFetchStub({});
    const onContainerCreated = vi.fn(async () => {});
    await makeAdapter(impl).publish(baseRequest({ onContainerCreated }));
    expect(onContainerCreated).toHaveBeenCalledWith("container_1");
  });

  it("reuses an existing container instead of creating a duplicate", async () => {
    const { impl, calls } = createFetchStub({});
    await makeAdapter(impl).publish(baseRequest({ existingContainerId: "container_existing" }));

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/media"))).toBe(false);
    expect(calls.at(-1)?.body).toContain("creation_id=container_existing");
  });

  it("sends alt_text when provided", async () => {
    const { impl, calls } = createFetchStub({});
    await makeAdapter(impl).publish(baseRequest({ altText: "a cat" }));
    expect(calls[0].body).toContain("alt_text=");
  });

  it("creates a REELS container for reels", async () => {
    const { impl, calls } = createFetchStub({});
    await makeAdapter(impl).publish(
      baseRequest({
        kind: "reel",
        media: [{ kind: "video", url: "https://cdn.example.com/a.mp4", mimeType: "video/mp4" }],
      }),
    );
    expect(calls[0].body).toContain("media_type=REELS");
    expect(calls[0].body).toContain("video_url=");
  });

  it("creates child containers then a CAROUSEL parent", async () => {
    let containerCount = 0;
    const { impl, calls } = createFetchStub({ createContainer: () => ({ id: `child_${++containerCount}` }) });

    await makeAdapter(impl).publish(
      baseRequest({
        kind: "carousel",
        media: [
          { kind: "image", url: "https://cdn.example.com/1.jpg", mimeType: "image/jpeg" },
          { kind: "image", url: "https://cdn.example.com/2.jpg", mimeType: "image/jpeg" },
        ],
      }),
    );

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts[0].body).toContain("is_carousel_item=true");
    expect(posts[1].body).toContain("is_carousel_item=true");
    const parent = posts.find((c) => c.body?.includes("media_type=CAROUSEL"));
    expect(parent?.body).toContain("children=");
  });

  it("fails fast on text content without calling Meta", async () => {
    const { impl, calls } = createFetchStub({});
    await expect(makeAdapter(impl).publish(baseRequest({ kind: "text", media: [] }))).rejects.toBeInstanceOf(
      PublishingError,
    );
    expect(calls).toHaveLength(0);
  });

  it("surfaces CONTAINER_FAILED when Meta reports ERROR", async () => {
    const { impl } = createFetchStub({ status: () => ({ status_code: "ERROR" }) });
    await expect(makeAdapter(impl).publish(baseRequest())).rejects.toMatchObject({
      publishingErrorCode: "CONTAINER_FAILED",
    });
  });

  it("surfaces CONTAINER_EXPIRED when Meta reports EXPIRED", async () => {
    const { impl } = createFetchStub({ status: () => ({ status_code: "EXPIRED" }) });
    await expect(makeAdapter(impl).publish(baseRequest())).rejects.toMatchObject({
      publishingErrorCode: "CONTAINER_EXPIRED",
    });
  });

  it("stops polling after the maximum attempts rather than looping forever", async () => {
    const { impl } = createFetchStub({ status: () => ({ status_code: "IN_PROGRESS" }) });
    await expect(makeAdapter(impl).publish(baseRequest())).rejects.toMatchObject({
      publishingErrorCode: "CONTAINER_FAILED",
    });
  });
});

describe("InstagramAdapter error classification", () => {
  it.each([
    [401, { error: { code: 190, message: "expired" } }, "AUTHENTICATION_FAILED"],
    [403, { error: { code: 200, message: "no permission" } }, "PERMISSION_DENIED"],
    [429, { error: { code: 4, message: "throttled" } }, "RATE_LIMITED"],
    [400, { error: { code: 100, error_subcode: 2207052, message: "cannot fetch" } }, "MEDIA_NOT_ACCESSIBLE"],
    [400, { error: { code: 100, error_subcode: 2207009, message: "bad aspect" } }, "MEDIA_INVALID"],
    [500, { error: { message: "server" } }, "PLATFORM_ERROR"],
  ])("maps HTTP %s to %s", async (status, body, expected) => {
    const { impl } = createFetchStub({ failNext: { status, body } });
    await expect(makeAdapter(impl).publish(baseRequest())).rejects.toMatchObject({
      publishingErrorCode: expected,
    });
  });

  it("never leaks the access token in the error message or provider detail", async () => {
    const { impl } = createFetchStub({ failNext: { status: 401, body: { error: { code: 190, message: "bad" } } } });

    const error = await makeAdapter(impl)
      .publish(baseRequest())
      .then(() => null)
      .catch((e: unknown) => e as PublishingError);

    expect(error).toBeInstanceOf(PublishingError);
    expect(error!.message).not.toContain("PAGE_TOKEN");
    expect(error!.providerDetail ?? "").not.toContain("PAGE_TOKEN");
  });
});
