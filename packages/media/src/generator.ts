/**
 * Placeholder abstraction for future image/video generation. Kept
 * provider-agnostic for the same reason as LLMProvider — concrete
 * implementations (e.g. an image-gen API) will implement this interface
 * without the agent system depending on any specific vendor.
 */
export interface GenerateImageInput {
  prompt: string;
  aspectRatio?: "1:1" | "4:5" | "9:16" | "16:9";
}

export interface GenerateImageResult {
  url: string;
  mimeType: string;
}

export interface MediaGenerator {
  readonly name: string;
  generateImage(input: GenerateImageInput): Promise<GenerateImageResult>;
}

/** Stub implementation until a real media-generation provider is wired in. */
export class MockMediaGenerator implements MediaGenerator {
  readonly name = "mock";

  async generateImage(_input: GenerateImageInput): Promise<GenerateImageResult> {
    return { url: "https://placehold.co/1080x1080", mimeType: "image/png" };
  }
}
