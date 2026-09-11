import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { CloudflareR2Storage } from "../providers/cloudflare-r2-storage.js";
import { MediaStorageService } from "../media-storage-service.js";
import { TEST_KEY_PREFIX } from "../object-key.js";

/**
 * Talks to the REAL Cloudflare R2 bucket. Opt-in only:
 *
 *   R2_INTEGRATION_TEST=true npx vitest run packages/media
 *
 * It is skipped by default and must never be enabled in CI. Every object it
 * creates lives under the `_test/` prefix and is deleted in cleanup, so it
 * cannot touch real content assets.
 */

const enabled = process.env.R2_INTEGRATION_TEST === "true";
const config = {
  accountId: process.env.R2_ACCOUNT_ID ?? "",
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  bucket: process.env.R2_BUCKET_NAME ?? "",
  publicBaseUrl: process.env.R2_PUBLIC_BASE_URL ?? "",
};
const configured = Object.values(config).every(Boolean);

const uploadedKeys: string[] = [];
const storage = enabled && configured ? new CloudflareR2Storage(config) : null;

afterAll(async () => {
  // Only ever removes keys this test created, all under the test prefix.
  for (const key of uploadedKeys) {
    if (!key.startsWith(`${TEST_KEY_PREFIX}/`)) continue;
    await storage?.delete(key).catch(() => undefined);
  }
});

describe.skipIf(!enabled || !configured)("Cloudflare R2 (real bucket)", () => {
  it("uploads a JPEG, serves it publicly over HTTPS, then deletes it", async () => {
    const service = new MediaStorageService(storage!);
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#3355ff" } })
      .jpeg()
      .toBuffer();

    const stored = await service.storeImage({
      accountId: "integration",
      contentId: "smoke",
      assetId: `asset-${Date.now()}`,
      data: jpeg,
      mimeType: "image/jpeg",
      prefix: TEST_KEY_PREFIX,
    });
    uploadedKeys.push(stored.objectKey);

    expect(stored.objectKey.startsWith(`${TEST_KEY_PREFIX}/`)).toBe(true);
    expect(stored.publicUrl.startsWith("https://")).toBe(true);
    expect(stored.storageProvider).toBe("cloudflare-r2");

    // The object is really in the bucket...
    expect(await service.exists(stored.objectKey)).toBe(true);

    // ...and reachable by an anonymous fetcher, which is what Meta will be.
    const verified = await service.verifyPublicUrl(stored.objectKey, { checkReachable: true });
    expect(verified.reachable).toBe(true);
    expect(verified.contentType).toBe("image/jpeg");

    const response = await fetch(stored.publicUrl);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Number(response.headers.get("content-length"))).toBe(stored.size);

    await service.deleteAsset(stored.objectKey);
    expect(await service.exists(stored.objectKey)).toBe(false);
  }, 60_000);

  it("converts a generated SVG to a JPEG that R2 serves with the right content type", async () => {
    const service = new MediaStorageService(storage!);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="100%" height="100%" fill="#1f2530"/></svg>',
    );

    const stored = await service.storeImage({
      accountId: "integration",
      contentId: "smoke",
      assetId: `svg-${Date.now()}`,
      data: svg,
      mimeType: "image/svg+xml",
      prefix: TEST_KEY_PREFIX,
    });
    uploadedKeys.push(stored.objectKey);

    expect(stored.converted).toBe(true);
    expect(stored.contentType).toBe("image/jpeg");
    expect(stored.objectKey.endsWith(".jpg")).toBe(true);

    const response = await fetch(stored.publicUrl);
    expect(response.headers.get("content-type")).toBe("image/jpeg");

    await service.deleteAsset(stored.objectKey);
  }, 60_000);
});
