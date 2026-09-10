import { AppError } from "@agent/shared";

export class ImageGenerationError extends AppError {
  constructor(provider: string, message: string) {
    super(`Image generation failed (${provider}): ${message}`, {
      statusCode: 502,
      code: "IMAGE_GENERATION_ERROR",
    });
  }
}
