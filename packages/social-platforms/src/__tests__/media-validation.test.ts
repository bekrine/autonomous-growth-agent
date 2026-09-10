import { describe, expect, it } from "vitest";
import { isPubliclyFetchableUrl, redactUrl, validateInstagramMedia } from "../media-validation.js";
import type { PublishMediaItem } from "../publishing-types.js";

const jpeg = (url = "https://cdn.example.com/a.jpg"): PublishMediaItem => ({
  kind: "image",
  url,
  mimeType: "image/jpeg",
});
const mp4 = (url = "https://cdn.example.com/a.mp4"): PublishMediaItem => ({
  kind: "video",
  url,
  mimeType: "video/mp4",
});

describe("validateInstagramMedia", () => {
  it("accepts a public JPEG for an image post", () => {
    expect(validateInstagramMedia("image", [jpeg()]).valid).toBe(true);
  });

  it("rejects non-JPEG images (Meta supports JPEG only)", () => {
    const result = validateInstagramMedia("image", [
      { kind: "image", url: "https://cdn.example.com/a.svg", mimeType: "image/svg+xml" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toMatch(/JPEG/);
  });

  it("rejects localhost media — Meta fetches server-side", () => {
    const result = validateInstagramMedia("image", [jpeg("http://localhost:4000/media/a.jpg")]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "MEDIA_NOT_ACCESSIBLE")).toBe(true);
  });

  it("rejects text posts outright", () => {
    const result = validateInstagramMedia("text", []);
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toMatch(/text-only/i);
  });

  it("requires a video for reels", () => {
    const result = validateInstagramMedia("reel", [jpeg()]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes("Reel requires a video"))).toBe(true);
  });

  it("accepts a valid reel", () => {
    expect(validateInstagramMedia("reel", [mp4()]).valid).toBe(true);
  });

  it("enforces carousel item bounds (2-10)", () => {
    expect(validateInstagramMedia("carousel", [jpeg()]).valid).toBe(false);
    expect(validateInstagramMedia("carousel", [jpeg(), jpeg()]).valid).toBe(true);
    const eleven = Array.from({ length: 11 }, () => jpeg());
    expect(validateInstagramMedia("carousel", eleven).valid).toBe(false);
  });

  it("reports empty media", () => {
    const result = validateInstagramMedia("image", []);
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toMatch(/No media/);
  });
});

describe("isPubliclyFetchableUrl", () => {
  it.each([
    ["https://cdn.example.com/a.jpg", true],
    ["https://abc123.ngrok-free.app/media/a.jpg", true],
    ["http://localhost:4000/a.jpg", false],
    ["http://127.0.0.1/a.jpg", false],
    ["http://192.168.1.10/a.jpg", false],
    ["http://10.0.0.5/a.jpg", false],
    ["http://172.16.4.2/a.jpg", false],
    ["http://my-box.local/a.jpg", false],
    ["not-a-url", false],
  ])("%s -> %s", (url, expected) => {
    expect(isPubliclyFetchableUrl(url)).toBe(expected);
  });
});

describe("redactUrl", () => {
  it("drops the query string so signed-URL credentials are never logged", () => {
    expect(redactUrl("https://cdn.example.com/a.jpg?X-Amz-Signature=secret")).toBe("https://cdn.example.com/a.jpg");
  });
});
