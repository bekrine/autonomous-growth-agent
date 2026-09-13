import { ImageGenerationError } from "../errors.js";
import { MP4_MIME_TYPE, type VideoGenerationInput, type VideoGenerationResult, type VideoGenerator } from "../video-generator.js";

export interface AgnesVideoGeneratorOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Frames per second. Duration = numFrames / frameRate. */
  frameRate?: number;
  /** 480p/720p/1080p tiers; the API normalizes to the nearest. */
  width?: number;
  height?: number;
  /** Bounded polling: generation is asynchronous and must not hang forever. */
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://apihub.agnes-ai.com/v1";
const DEFAULT_MODEL = "agnes-video-v2.0";
const DEFAULT_FRAME_RATE = 24;
const DEFAULT_MAX_POLL_ATTEMPTS = 60;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Vertical by default — Reels are 9:16. */
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 1280;

/** The API requires num_frames to satisfy 8n + 1, capped at 441. */
const MAX_FRAMES = 441;

export function toValidFrameCount(desiredFrames: number): number {
  const clamped = Math.max(9, Math.min(MAX_FRAMES, Math.round(desiredFrames)));
  // Round down to the nearest 8n+1 so we never exceed the requested duration.
  const n = Math.floor((clamped - 1) / 8);
  return n * 8 + 1;
}

/**
 * Video generation via Agnes AI.
 *
 * Asynchronous by nature — create a task, then poll until it finishes — so the
 * same discipline as the Instagram publishing container applies: polling is
 * bounded by attempt count, and a task that never completes fails rather than
 * hanging the pipeline.
 *
 * The free tier allows 2 requests/minute for video, which is why this is
 * opt-in rather than implied by simply holding an Agnes key.
 */
export class AgnesVideoGenerator implements VideoGenerator {
  readonly name = "agnes";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly frameRate: number;
  private readonly width: number;
  private readonly height: number;
  private readonly maxPollAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: AgnesVideoGeneratorOptions) {
    if (!options.apiKey) throw new ImageGenerationError("agnes-video", "An Agnes API key is required.");
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.frameRate = options.frameRate ?? DEFAULT_FRAME_RATE;
    this.width = options.width ?? DEFAULT_WIDTH;
    this.height = options.height ?? DEFAULT_HEIGHT;
    this.maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationResult> {
    const seconds = input.durationSeconds ?? 5;
    const numFrames = toValidFrameCount(seconds * this.frameRate);

    const created = await this.request<AgnesVideoTask>("POST", "/videos", {
      model: this.model,
      prompt: input.prompt,
      num_frames: numFrames,
      frame_rate: this.frameRate,
      width: this.width,
      height: this.height,
    });

    const videoId = created.video_id ?? created.id;
    const taskId = created.task_id ?? created.id;
    if (!videoId && !taskId) {
      throw new ImageGenerationError(this.name, "The API did not return a task or video id.");
    }

    const url = await this.pollForVideoUrl(videoId, taskId);
    const data = await this.download(url);

    return {
      status: "completed",
      provider: this.name,
      assetId: videoId ?? taskId,
      videoData: data,
      mimeType: MP4_MIME_TYPE,
      durationSeconds: numFrames / this.frameRate,
    };
  }

  /** Bounded: a task that never finishes fails instead of blocking forever. */
  private async pollForVideoUrl(videoId: string | undefined, taskId: string | undefined): Promise<string> {
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));

      const status = videoId
        ? await this.request<AgnesVideoStatus>("GET", `/../agnesapi?video_id=${encodeURIComponent(videoId)}`)
        : await this.request<AgnesVideoStatus>("GET", `/videos/${encodeURIComponent(taskId!)}`);

      const state = (status.status ?? status.state ?? "").toLowerCase();
      const url = status.video_url ?? status.url ?? status.data?.[0]?.url;

      if (url) return url;
      if (state === "failed" || state === "error") {
        throw new ImageGenerationError(this.name, `Video generation failed: ${status.error ?? "unknown error"}`);
      }
    }

    throw new ImageGenerationError(
      this.name,
      `Video was still processing after ${this.maxPollAttempts} polls (~${Math.round(
        (this.maxPollAttempts * this.pollIntervalMs) / 1000,
      )}s).`,
    );
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    // `/../agnesapi` escapes the /v1 prefix for the recommended status route.
    const url = new URL(`${this.baseUrl}${path}`).toString();

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Timed out after ${this.requestTimeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new ImageGenerationError(this.name, message);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // Video is limited to 2 requests/minute on the free tier.
      const hint = response.status === 429 ? " (free-tier rate limit — 2 requests/minute for video)" : "";
      throw new ImageGenerationError(this.name, `HTTP ${response.status}${hint}: ${detail.slice(0, 300)}`);
    }

    return (await response.json()) as T;
  }

  private async download(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new ImageGenerationError(this.name, `Could not download the generated video (HTTP ${response.status}).`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

interface AgnesVideoTask {
  id?: string;
  task_id?: string;
  video_id?: string;
}

interface AgnesVideoStatus {
  status?: string;
  state?: string;
  video_url?: string;
  url?: string;
  error?: string;
  data?: { url?: string }[];
}
