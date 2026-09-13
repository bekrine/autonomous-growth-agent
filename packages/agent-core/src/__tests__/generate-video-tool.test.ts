import { describe, expect, it, vi } from "vitest";
import { InMemoryObjectStorage, MediaStorageService, type VideoGenerator } from "@agent/media";
import { GenerateVideoTool, MIN_REEL_SECONDS } from "../tools/generate-video.js";

function fakeGenerator(overrides: Partial<Awaited<ReturnType<VideoGenerator["generate"]>>> = {}) {
  const generate = vi.fn(async (input: { prompt: string; durationSeconds?: number }) => ({
    status: "completed" as const,
    provider: "fake",
    assetId: "provider-asset-1",
    videoData: Buffer.from("mp4-bytes"),
    mimeType: "video/mp4",
    durationSeconds: input.durationSeconds,
    ...overrides,
  }));
  return { name: "fake", generate } as unknown as VideoGenerator & { generate: typeof generate };
}

function buildTool(generator: VideoGenerator) {
  const storage = new InMemoryObjectStorage("https://pub-test.r2.dev");
  return { tool: new GenerateVideoTool(generator, new MediaStorageService(storage)), storage };
}

describe("GenerateVideoTool", () => {
  it("stores the generated video under the videos prefix and returns its public URL", async () => {
    const generator = fakeGenerator();
    const { tool, storage } = buildTool(generator);

    const result = await tool.execute({
      prompt: "a calm desk scene",
      durationSeconds: 6,
      accountId: "acc-1",
      contentId: "post-1",
      assetId: "asset-1",
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      storageKey: "accounts/acc-1/content/post-1/videos/asset-1.mp4",
      url: "https://pub-test.r2.dev/accounts/acc-1/content/post-1/videos/asset-1.mp4",
      mimeType: "video/mp4",
      provider: "fake",
      storageProvider: "in-memory",
      providerAssetId: "provider-asset-1",
    });
    expect(storage.objects.get(result.data!.storageKey)!.contentType).toBe("video/mp4");
  });

  it("raises a too-short duration to Instagram's Reels minimum", async () => {
    const generator = fakeGenerator();
    const { tool } = buildTool(generator);

    // Asking Meta to publish a 2s Reel fails at the container with a confusing
    // error, so the floor is applied before the model is even called.
    await tool.execute({ prompt: "x", durationSeconds: 2, accountId: "a", contentId: "c", assetId: "v" });

    expect(generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: MIN_REEL_SECONDS }),
    );
  });

  it("keeps a duration that already clears the minimum", async () => {
    const generator = fakeGenerator();
    const { tool } = buildTool(generator);

    await tool.execute({ prompt: "x", durationSeconds: 12, accountId: "a", contentId: "c", assetId: "v" });

    expect(generator.generate).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 12 }));
  });

  it("fails cleanly when the generator returns no bytes", async () => {
    // The mock generator and a provider reporting "mocked" both land here.
    const generator = fakeGenerator({ videoData: undefined, status: "mocked" });
    const { tool } = buildTool(generator);

    const result = await tool.execute({ prompt: "x", accountId: "a", contentId: "c", assetId: "v" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no video data");
  });
});
