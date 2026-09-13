import type { ImageGenerationInput, ImageGenerationResult, ImageGenerator } from "../image-generator.js";
import { ImageGenerationError } from "../errors.js";

export interface AgnesImageGeneratorOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Bounded wait for the generation call itself. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://apihub.agnes-ai.com/v1";
const DEFAULT_MODEL = "agnes-image-2.1-flash";
const DEFAULT_TIMEOUT_MS = 120_000;

/** Instagram wants square; the API normalizes to standard tiers anyway. */
const SIZE_BY_ASPECT_RATIO: Record<string, string> = {
  "1:1": "1024x1024",
  "4:5": "1024x1280",
  "9:16": "1024x1792",
  "16:9": "1792x1024",
};

/**
 * Image generation via Agnes AI's OpenAI-compatible endpoint.
 *
 * Two quirks of this API are handled deliberately:
 *
 *  1. `response_format` must sit inside `extra_body`, not at the top level.
 *     Putting it at the top level is silently ignored.
 *  2. We ask for a URL and fetch the bytes ourselves rather than requesting
 *     base64. Agnes has an open bug where b64 responses hang for minutes
 *     (AgnesAI-Labs/AgnesAI-Models#129), and our pipeline needs a Buffer to
 *     hand to object storage either way — so the URL path is both safer and
 *     no more work.
 *
 * Returns raw bytes; persisting them is the caller's job.
 */
export class AgnesImageGenerator implements ImageGenerator {
  readonly name = "agnes";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: AgnesImageGeneratorOptions) {
    if (!options.apiKey) throw new ImageGenerationError("agnes", "An Agnes API key is required.");
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const size = SIZE_BY_ASPECT_RATIO[input.aspectRatio ?? "1:1"] ?? SIZE_BY_ASPECT_RATIO["1:1"]!;

    const payload = await this.post("/images/generations", {
      model: this.model,
      prompt: input.prompt,
      size,
      // Nested, per the API's contract — see the class comment.
      extra_body: { response_format: "url" },
    });

    const entry = payload.data?.[0];
    if (!entry) {
      throw new ImageGenerationError(this.name, "The API returned no image data.");
    }

    // Prefer the URL, but accept inline base64 if the API returns it anyway.
    if (entry.url) {
      const { data, mimeType } = await this.download(entry.url);
      return {
        imageData: data,
        mimeType,
        provider: this.name,
        providerAssetId: payload.id,
        ...parseSize(size),
      };
    }

    if (entry.b64_json) {
      return {
        imageData: Buffer.from(entry.b64_json, "base64"),
        mimeType: "image/png",
        provider: this.name,
        providerAssetId: payload.id,
        ...parseSize(size),
      };
    }

    throw new ImageGenerationError(this.name, "The API response contained neither a URL nor base64 image data.");
  }

  private async post(path: string, body: Record<string, unknown>): Promise<AgnesImageResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Timed out after ${this.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new ImageGenerationError(this.name, message);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // 429 is the free tier's 30 RPM limit — worth naming so it is not
      // mistaken for a broken key.
      const hint = response.status === 429 ? " (free-tier rate limit — 30 requests/minute)" : "";
      throw new ImageGenerationError(this.name, `HTTP ${response.status}${hint}: ${detail.slice(0, 300)}`);
    }

    return (await response.json()) as AgnesImageResponse;
  }

  /** The returned URL is a plain asset link; no credentials are attached. */
  private async download(url: string): Promise<{ data: Buffer; mimeType: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new ImageGenerationError(this.name, `Could not download the generated image (HTTP ${response.status}).`);
      }
      return {
        data: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type")?.split(";")[0] ?? "image/png",
      };
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      throw new ImageGenerationError(this.name, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

interface AgnesImageResponse {
  id?: string;
  data?: { url?: string; b64_json?: string }[];
}

function parseSize(size: string): { width?: number; height?: number } {
  const [width, height] = size.split("x").map(Number);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {};
}
