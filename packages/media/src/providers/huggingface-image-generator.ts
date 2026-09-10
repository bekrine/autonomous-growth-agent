import type { ImageGenerationInput, ImageGenerationResult, ImageGenerator } from "../image-generator.js";
import { ImageGenerationError } from "../errors.js";

export interface HuggingFaceImageGeneratorOptions {
  /** A Hugging Face access token with "Inference Providers" permission. */
  apiKey: string;
  model?: string;
  /**
   * Which Inference Provider serves the model. As of this writing Hugging
   * Face's own free `hf-inference` provider no longer serves text-to-image
   * (all such models return 410 "deprecated"), so image generation routes
   * to a third-party provider and requires Inference Provider credits.
   */
  provider?: string;
}

const DEFAULT_MODEL = "black-forest-labs/FLUX.1-schnell";
const DEFAULT_PROVIDER = "fal-ai";

/**
 * Real image generation via Hugging Face's Inference Providers router.
 * Returns raw image bytes — storing them is the caller's job
 * (packages/agent-core persists through the ObjectStorage abstraction).
 *
 * NOTE: this path needs HF Inference Provider credits; see
 * `createImageGenerator` for why it is opt-in rather than implied by
 * simply having an HF token.
 */
export class HuggingFaceImageGenerator implements ImageGenerator {
  readonly name = "huggingface";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly provider: string;

  constructor(options: HuggingFaceImageGeneratorOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.provider = options.provider ?? DEFAULT_PROVIDER;
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const url = `https://router.huggingface.co/${this.provider}/models/${this.model}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: input.prompt }),
      });
    } catch (error) {
      throw new ImageGenerationError(this.name, error instanceof Error ? error.message : String(error));
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ImageGenerationError(this.name, `HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const mimeType = response.headers.get("content-type") ?? "image/png";

    return {
      imageData: Buffer.from(arrayBuffer),
      mimeType,
      provider: this.name,
    };
  }
}
