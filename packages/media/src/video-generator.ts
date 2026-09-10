/**
 * Provider-agnostic video generation. Real video generation is out of
 * scope for this phase (explicitly deferred) — this interface and its
 * mock implementation exist so a real provider can be added later without
 * touching the content-generation pipeline. Nothing in the pipeline calls
 * a real video provider yet; Reels get a cover image (via ImageGenerator)
 * instead of an actual rendered video.
 */
export interface VideoGenerationInput {
  prompt: string;
  durationSeconds?: number;
}

export interface VideoGenerationResult {
  status: "mocked" | "completed";
  provider: string;
  assetId?: string;
}

export interface VideoGenerator {
  readonly name: string;
  generate(input: VideoGenerationInput): Promise<VideoGenerationResult>;
}

/** The only implementation for now — never claims a real video was generated. */
export class MockVideoGenerator implements VideoGenerator {
  readonly name = "mock";

  async generate(_input: VideoGenerationInput): Promise<VideoGenerationResult> {
    return { status: "mocked", provider: "mock" };
  }
}
