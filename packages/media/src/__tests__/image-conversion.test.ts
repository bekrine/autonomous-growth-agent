import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { convertImageToJpeg, isConvertibleImage } from "../image-conversion.js";
import { ImageConversionError } from "../errors.js";
import { MockImageGenerator } from "../providers/mock-image-generator.js";

/** JPEG files start with the SOI marker FF D8 FF — proof the bytes really were re-encoded. */
function isJpegBytes(data: Buffer): boolean {
  return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

describe("convertImageToJpeg", () => {
  it("converts the mock generator's SVG into real JPEG bytes", async () => {
    const generated = await new MockImageGenerator().generate({ prompt: "a test prompt" });
    expect(generated.mimeType).toBe("image/svg+xml");

    const result = await convertImageToJpeg(generated.imageData, generated.mimeType);

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.converted).toBe(true);
    // Not just a relabel: the bytes themselves are a JPEG.
    expect(isJpegBytes(result.data)).toBe(true);
    expect((await sharp(result.data).metadata()).format).toBe("jpeg");
  });

  it("rasterizes an SVG at its declared size rather than inflating it", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect width="100%" height="100%" fill="#123"/></svg>',
    );
    const result = await convertImageToJpeg(svg, "image/svg+xml");

    expect(result.width).toBe(1080);
    expect(result.height).toBe(1080);
  });

  it("flattens transparency onto white instead of leaving it black", async () => {
    const transparentPng = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    const result = await convertImageToJpeg(transparentPng, "image/png");
    const { data } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });

    expect(result.mimeType).toBe("image/jpeg");
    expect(data[0]).toBeGreaterThan(240);
  });

  it("passes an existing JPEG through without re-encoding it", async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } })
      .jpeg()
      .toBuffer();

    const result = await convertImageToJpeg(jpeg, "image/jpeg");

    expect(result.converted).toBe(false);
    expect(result.data).toBe(jpeg);
  });

  it("rejects a type it cannot decode rather than producing a broken object", async () => {
    await expect(convertImageToJpeg(Buffer.from("not an image"), "application/pdf")).rejects.toBeInstanceOf(
      ImageConversionError,
    );
  });

  it("reports which formats are convertible", () => {
    expect(isConvertibleImage("image/svg+xml")).toBe(true);
    expect(isConvertibleImage("IMAGE/PNG")).toBe(true);
    expect(isConvertibleImage("video/mp4")).toBe(false);
  });
});
