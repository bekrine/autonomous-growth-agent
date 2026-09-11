import { describe, expect, it } from "vitest";
import { MediaStorageService } from "../media-storage-service.js";
import { InMemoryObjectStorage } from "../storage.js";
import { buildObjectKey, sanitizeKeySegment, TEST_KEY_PREFIX } from "../object-key.js";
import { MockImageGenerator } from "../providers/mock-image-generator.js";
import { MockVideoGenerator } from "../video-generator.js";
import { StorageError } from "../errors.js";

function isJpegBytes(data: Buffer): boolean {
  return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

describe("object keys", () => {
  it("groups by account and content, and names the object after the asset id", () => {
    const key = buildObjectKey({
      accountId: "acc-1",
      contentId: "content-2",
      assetId: "asset-3",
      kind: "images",
      mimeType: "image/jpeg",
    });
    expect(key).toBe("accounts/acc-1/content/content-2/images/asset-3.jpg");
  });

  it("uses the right folder and extension per media kind", () => {
    const base = { accountId: "a", contentId: "c", assetId: "x" } as const;
    expect(buildObjectKey({ ...base, kind: "videos", mimeType: "video/mp4" })).toBe("accounts/a/content/c/videos/x.mp4");
    expect(buildObjectKey({ ...base, kind: "thumbnails", mimeType: "image/jpeg" })).toBe(
      "accounts/a/content/c/thumbnails/x.jpg",
    );
  });

  it("neutralizes path traversal and separators so a key cannot escape its prefix", () => {
    expect(sanitizeKeySegment("../../etc/passwd")).not.toContain("/");
    expect(sanitizeKeySegment("../../etc/passwd")).not.toContain("..");

    const key = buildObjectKey({
      accountId: "../../evil",
      contentId: "c",
      assetId: "a",
      kind: "images",
      mimeType: "image/jpeg",
    });
    expect(key.startsWith("accounts/")).toBe(true);
    expect(key).not.toContain("..");
  });

  it("isolates test objects under a dedicated prefix", () => {
    const key = buildObjectKey({
      accountId: "a",
      contentId: "c",
      assetId: "x",
      kind: "images",
      mimeType: "image/jpeg",
      prefix: TEST_KEY_PREFIX,
    });
    expect(key.startsWith(`${TEST_KEY_PREFIX}/`)).toBe(true);
  });
});

describe("MediaStorageService.storeImage", () => {
  it("converts generated SVG to JPEG and stores it under a deterministic key", async () => {
    const storage = new InMemoryObjectStorage("https://pub-test.r2.dev");
    const service = new MediaStorageService(storage);
    const generated = await new MockImageGenerator().generate({ prompt: "hello" });

    const stored = await service.storeImage({
      accountId: "acc-1",
      contentId: "post-1",
      assetId: "asset-1",
      data: generated.imageData,
      mimeType: generated.mimeType,
    });

    expect(stored.objectKey).toBe("accounts/acc-1/content/post-1/images/asset-1.jpg");
    expect(stored.publicUrl).toBe("https://pub-test.r2.dev/accounts/acc-1/content/post-1/images/asset-1.jpg");
    expect(stored.contentType).toBe("image/jpeg");
    expect(stored.converted).toBe(true);
    // The audit trail stays honest about what the generator actually produced.
    expect(stored.originalMimeType).toBe("image/svg+xml");

    const object = storage.objects.get(stored.objectKey)!;
    expect(object.contentType).toBe("image/jpeg");
    expect(isJpegBytes(object.data)).toBe(true);
    expect(stored.size).toBe(object.data.byteLength);
  });

  it("attaches only identifying metadata to the object", async () => {
    const storage = new InMemoryObjectStorage();
    const service = new MediaStorageService(storage);

    const stored = await service.storeImage({
      accountId: "acc-1",
      contentId: "post-1",
      assetId: "asset-1",
      data: (await new MockImageGenerator().generate({ prompt: "x" })).imageData,
      mimeType: "image/svg+xml",
    });

    expect(storage.objects.get(stored.objectKey)!.metadata).toEqual({
      "account-id": "acc-1",
      "content-id": "post-1",
      "asset-id": "asset-1",
    });
  });

  it("refuses media it cannot make publishable", async () => {
    const service = new MediaStorageService(new InMemoryObjectStorage());

    await expect(
      service.storeImage({
        accountId: "a",
        contentId: "c",
        assetId: "x",
        data: Buffer.from("%PDF-"),
        mimeType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it("re-storing the same asset overwrites one object rather than accumulating duplicates", async () => {
    const storage = new InMemoryObjectStorage();
    const service = new MediaStorageService(storage);
    const input = {
      accountId: "a",
      contentId: "c",
      assetId: "same-asset",
      data: (await new MockImageGenerator().generate({ prompt: "x" })).imageData,
      mimeType: "image/svg+xml",
    };

    const first = await service.storeImage(input);
    const second = await service.storeImage(input);

    expect(second.objectKey).toBe(first.objectKey);
    expect(storage.objects.size).toBe(1);
  });
});

describe("MediaStorageService.storeVideo", () => {
  it("uploads the mock generator's MP4 under the videos prefix", async () => {
    const storage = new InMemoryObjectStorage("https://pub-test.r2.dev");
    const service = new MediaStorageService(storage);
    const generated = await new MockVideoGenerator().generate({ prompt: "a reel", durationSeconds: 5 });

    expect(generated.videoData).toBeDefined();
    const stored = await service.storeVideo({
      accountId: "acc-1",
      contentId: "post-1",
      assetId: "asset-9",
      data: generated.videoData!,
      mimeType: generated.mimeType,
    });

    expect(stored.objectKey).toBe("accounts/acc-1/content/post-1/videos/asset-9.mp4");
    expect(stored.contentType).toBe("video/mp4");
    expect(storage.objects.get(stored.objectKey)!.data.subarray(4, 8).toString("ascii")).toBe("ftyp");
  });
});

describe("MediaStorageService lifecycle", () => {
  it("supports exists, public URL and delete through the abstraction", async () => {
    const storage = new InMemoryObjectStorage();
    const service = new MediaStorageService(storage);
    const stored = await service.storeImage({
      accountId: "a",
      contentId: "c",
      assetId: "x",
      data: (await new MockImageGenerator().generate({ prompt: "x" })).imageData,
      mimeType: "image/svg+xml",
    });

    expect(await service.exists(stored.objectKey)).toBe(true);
    expect(await service.getPublicUrl(stored.objectKey)).toBe(stored.publicUrl);

    await service.deleteAsset(stored.objectKey);
    expect(await service.exists(stored.objectKey)).toBe(false);
  });

  it("verifies a public URL without a network call unless asked", async () => {
    const storage = new InMemoryObjectStorage();
    const service = new MediaStorageService(storage);
    const stored = await service.storeImage({
      accountId: "a",
      contentId: "c",
      assetId: "x",
      data: (await new MockImageGenerator().generate({ prompt: "x" })).imageData,
      mimeType: "image/svg+xml",
    });

    const check = await service.verifyPublicUrl(stored.objectKey);
    expect(check.exists).toBe(true);
    expect(check.publicUrl).toBe(stored.publicUrl);
    expect(check.reachable).toBeUndefined();
  });
});
