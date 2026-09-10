import { describe, expect, it, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalObjectStorage } from "../storage.js";

describe("LocalObjectStorage", () => {
  const cleanupDirs: string[] = [];
  afterAll(async () => {
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes bytes to disk and returns a fetchable url", async () => {
    const dir = await mkdtemp(join(tmpdir(), "media-storage-test-"));
    cleanupDirs.push(dir);
    const storage = new LocalObjectStorage(dir, "http://localhost:4000/media");

    const result = await storage.put({
      key: "content/test-asset.png",
      data: Buffer.from("fake-image-bytes"),
      contentType: "image/png",
    });

    expect(result.url).toBe("http://localhost:4000/media/content/test-asset.png");
    const written = await readFile(join(dir, "content/test-asset.png"));
    expect(written.toString()).toBe("fake-image-bytes");
  });
});
