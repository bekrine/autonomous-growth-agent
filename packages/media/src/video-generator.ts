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
  /**
   * Present when the generator produced actual bytes. The mock emits a tiny
   * but structurally valid MP4 so the storage path (upload, content type,
   * public URL) is exercised end to end for video, even though no real video
   * generation happens yet.
   */
  videoData?: Buffer;
  mimeType?: string;
  durationSeconds?: number;
}

export interface VideoGenerator {
  readonly name: string;
  generate(input: VideoGenerationInput): Promise<VideoGenerationResult>;
}

export const MP4_MIME_TYPE = "video/mp4";

/**
 * A minimal ISO Base Media File Format header: an `ftyp` box declaring the
 * `isom` brand followed by an empty `mdat`. Enough for content-type sniffing
 * and storage round-trips; deliberately NOT a playable video, because
 * claiming otherwise would misrepresent a mock as real output.
 */
function deterministicMp4(): Buffer {
  const ftyp = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftyp", "ascii"),
    Buffer.from("isom", "ascii"),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from("isomiso2", "ascii"),
  ]);
  const mdat = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x08]), Buffer.from("mdat", "ascii")]);
  return Buffer.concat([ftyp, mdat]);
}

/** The only implementation for now — never claims a real video was generated. */
export class MockVideoGenerator implements VideoGenerator {
  readonly name = "mock";

  async generate(input: VideoGenerationInput): Promise<VideoGenerationResult> {
    return {
      status: "mocked",
      provider: "mock",
      videoData: deterministicMp4(),
      mimeType: MP4_MIME_TYPE,
      durationSeconds: input.durationSeconds,
    };
  }
}
