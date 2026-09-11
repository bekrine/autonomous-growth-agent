import sharp from "sharp";
import { ImageConversionError } from "./errors.js";

/**
 * Instagram's Content Publishing API accepts JPEG only — not PNG, not WebP,
 * and definitely not the SVG our mock generator produces. Rather than
 * relabeling an SVG as "image/jpeg" and letting Meta reject it with an
 * opaque error, we genuinely re-encode the bytes here.
 *
 * The original generated asset and the publishable asset stay separate
 * concepts: callers keep the source result and store the converted output,
 * so nothing pretends a conversion did not happen.
 */

export const INSTAGRAM_IMAGE_MIME_TYPE = "image/jpeg";

/** Formats sharp can decode and that we are willing to publish from. */
const CONVERTIBLE = new Set(["image/jpeg", "image/png", "image/webp", "image/svg+xml", "image/avif", "image/tiff"]);

export interface ConvertedImage {
  data: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  /** True when the bytes were actually re-encoded rather than passed through. */
  converted: boolean;
}

export interface ConvertToJpegOptions {
  quality?: number;
  /**
   * DPI used to rasterize vector input. 72 maps an SVG's declared pixel
   * dimensions 1:1; our generated SVGs already declare the target size, so
   * raising this only produces a larger, slower raster (144 quadruples the
   * pixel count and was ~6.7x slower in practice). Raise it only for vector
   * art whose declared size is smaller than the output you want.
   */
  density?: number;
}

export function isConvertibleImage(mimeType: string): boolean {
  return CONVERTIBLE.has(mimeType.toLowerCase());
}

/**
 * Re-encodes any supported image to JPEG. A JPEG input is returned
 * untouched so we never lose quality re-encoding something already correct.
 */
export async function convertImageToJpeg(
  data: Buffer,
  sourceMimeType: string,
  options: ConvertToJpegOptions = {},
): Promise<ConvertedImage> {
  const mime = sourceMimeType.toLowerCase();

  if (!isConvertibleImage(mime)) {
    throw new ImageConversionError(`unsupported source type ${sourceMimeType}`);
  }

  if (mime === INSTAGRAM_IMAGE_MIME_TYPE) {
    const meta = await safeMetadata(data);
    return { data, mimeType: INSTAGRAM_IMAGE_MIME_TYPE, width: meta.width, height: meta.height, converted: false };
  }

  try {
    // `density` only affects vector input; it is what stops an SVG from
    // rasterizing at a blurry default size.
    const pipeline = sharp(data, mime === "image/svg+xml" ? { density: options.density ?? 72 } : undefined);

    const output = await pipeline
      // JPEG cannot store transparency; without a background, alpha goes black.
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: options.quality ?? 90, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return {
      data: output.data,
      mimeType: INSTAGRAM_IMAGE_MIME_TYPE,
      width: output.info.width,
      height: output.info.height,
      converted: true,
    };
  } catch (error) {
    throw new ImageConversionError(error instanceof Error ? error.message : String(error));
  }
}

async function safeMetadata(data: Buffer): Promise<{ width?: number; height?: number }> {
  try {
    const meta = await sharp(data).metadata();
    return { width: meta.width, height: meta.height };
  } catch {
    // Metadata is a nice-to-have; never fail an otherwise valid passthrough.
    return {};
  }
}
