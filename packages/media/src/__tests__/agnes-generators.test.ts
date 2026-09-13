import { afterEach, describe, expect, it, vi } from "vitest";
import { AgnesImageGenerator } from "../providers/agnes-image-generator.js";
import { AgnesVideoGenerator, toValidFrameCount } from "../providers/agnes-video-generator.js";
import { createImageGenerator, createVideoGenerator } from "../factory.js";
import { ImageGenerationError } from "../errors.js";

/** `fetch` is stubbed throughout — these tests never reach Agnes. */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(((input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    return Promise.resolve(handler(url, init) as Response);
  }) as typeof fetch);
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

function binaryResponse(bytes: Buffer, contentType: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => "",
    headers: new Headers({ "content-type": contentType }),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgnesImageGenerator", () => {
  it("requests a URL and downloads the bytes", async () => {
    const requests: { url: string; body?: unknown }[] = [];
    stubFetch((url, init) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/images/generations")) {
        return jsonResponse({ id: "img-1", data: [{ url: "https://cdn.example/generated.png" }] });
      }
      return binaryResponse(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    });

    const result = await new AgnesImageGenerator({ apiKey: "k" }).generate({ prompt: "a cat" });

    expect(result.provider).toBe("agnes");
    expect(result.mimeType).toBe("image/png");
    expect(result.imageData.length).toBe(4);
    expect(result.providerAssetId).toBe("img-1");

    // response_format must be nested — at the top level the API ignores it.
    const body = requests[0]!.body as Record<string, unknown>;
    expect(body.extra_body).toEqual({ response_format: "url" });
    expect(body).not.toHaveProperty("response_format");
    expect(body.model).toBe("agnes-image-2.1-flash");
  });

  it("sends an Authorization header and never puts the key in the URL", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    stubFetch((url, init) => {
      seen ??= { url, init };
      if (url.includes("/images/generations")) return jsonResponse({ data: [{ b64_json: "AAECAw==" }] });
      return binaryResponse(Buffer.alloc(1), "image/png");
    });

    await new AgnesImageGenerator({ apiKey: "secret-key" }).generate({ prompt: "x" });

    expect((seen!.init!.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    expect(seen!.url).not.toContain("secret-key");
  });

  it("accepts inline base64 when the API returns it instead of a URL", async () => {
    stubFetch(() => jsonResponse({ data: [{ b64_json: Buffer.from("hello").toString("base64") }] }));

    const result = await new AgnesImageGenerator({ apiKey: "k" }).generate({ prompt: "x" });
    expect(result.imageData.toString()).toBe("hello");
  });

  it("maps aspect ratio to a size the API understands", async () => {
    const bodies: Record<string, unknown>[] = [];
    stubFetch((url, init) => {
      if (url.includes("/images/generations")) {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ data: [{ b64_json: "AA==" }] });
      }
      return binaryResponse(Buffer.alloc(1), "image/png");
    });

    const generator = new AgnesImageGenerator({ apiKey: "k" });
    await generator.generate({ prompt: "x", aspectRatio: "1:1" });
    await generator.generate({ prompt: "x", aspectRatio: "9:16" });

    expect(bodies[0]!.size).toBe("1024x1024");
    expect(bodies[1]!.size).toBe("1024x1792");
  });

  it("names the free-tier rate limit rather than reporting a bare 429", async () => {
    stubFetch(() => jsonResponse({ error: "slow down" }, 429));

    const error: ImageGenerationError = await new AgnesImageGenerator({ apiKey: "k" })
      .generate({ prompt: "x" })
      .then(() => {
        throw new Error("expected the request to reject");
      })
      .catch((e: unknown) => e as ImageGenerationError);

    expect(error).toBeInstanceOf(ImageGenerationError);
    expect(error.message).toContain("30 requests/minute");
  });

  it("fails clearly when the response carries no image at all", async () => {
    stubFetch(() => jsonResponse({ data: [{}] }));

    await expect(new AgnesImageGenerator({ apiKey: "k" }).generate({ prompt: "x" })).rejects.toThrow(
      /neither a URL nor base64/i,
    );
  });

  it("requires an API key", () => {
    expect(() => new AgnesImageGenerator({ apiKey: "" })).toThrow(ImageGenerationError);
  });
});

describe("AgnesVideoGenerator", () => {
  it("creates a task, polls until a URL appears, then downloads the video", async () => {
    let statusCalls = 0;
    stubFetch((url) => {
      if (url.includes("/videos") && !url.includes("agnesapi")) {
        return jsonResponse({ video_id: "vid-1", task_id: "task-1" });
      }
      if (url.includes("agnesapi")) {
        statusCalls += 1;
        // Still rendering on the first poll — the generator must wait.
        return statusCalls < 2
          ? jsonResponse({ status: "processing" })
          : jsonResponse({ status: "succeeded", video_url: "https://cdn.example/v.mp4" });
      }
      return binaryResponse(Buffer.from("mp4-bytes"), "video/mp4");
    });

    const result = await new AgnesVideoGenerator({ apiKey: "k", pollIntervalMs: 1 }).generate({
      prompt: "a reel",
      durationSeconds: 5,
    });

    expect(result.status).toBe("completed");
    expect(result.provider).toBe("agnes");
    expect(result.mimeType).toBe("video/mp4");
    expect(result.videoData?.toString()).toBe("mp4-bytes");
    expect(statusCalls).toBe(2);
  });

  it("gives up after a bounded number of polls instead of hanging", async () => {
    stubFetch((url) => {
      if (url.includes("/videos") && !url.includes("agnesapi")) return jsonResponse({ video_id: "vid-1" });
      return jsonResponse({ status: "processing" });
    });

    await expect(
      new AgnesVideoGenerator({ apiKey: "k", pollIntervalMs: 1, maxPollAttempts: 3 }).generate({ prompt: "x" }),
    ).rejects.toThrow(/still processing after 3 polls/i);
  });

  it("surfaces a failed render rather than polling to the limit", async () => {
    stubFetch((url) => {
      if (url.includes("/videos") && !url.includes("agnesapi")) return jsonResponse({ video_id: "vid-1" });
      return jsonResponse({ status: "failed", error: "unsafe prompt" });
    });

    await expect(
      new AgnesVideoGenerator({ apiKey: "k", pollIntervalMs: 1 }).generate({ prompt: "x" }),
    ).rejects.toThrow(/unsafe prompt/);
  });

  it("names the tighter video rate limit", async () => {
    stubFetch(() => jsonResponse({ error: "slow down" }, 429));

    const error: ImageGenerationError = await new AgnesVideoGenerator({ apiKey: "k", pollIntervalMs: 1 })
      .generate({ prompt: "x" })
      .then(() => {
        throw new Error("expected the request to reject");
      })
      .catch((e: unknown) => e as ImageGenerationError);

    expect(error.message).toContain("2 requests/minute");
  });

  it("rounds frame counts to the API's 8n+1 rule and caps them", () => {
    // The API rejects anything not of the form 8n+1, and anything over 441.
    for (const frames of [9, 25, 48, 120, 441, 1000]) {
      const valid = toValidFrameCount(frames);
      expect((valid - 1) % 8).toBe(0);
      expect(valid).toBeGreaterThanOrEqual(9);
      expect(valid).toBeLessThanOrEqual(441);
    }
    expect(toValidFrameCount(1000)).toBe(441);
  });

  it("rounds to the nearest valid count so a clip is not noticeably short", () => {
    // 2s at 24fps = 48 frames. Rounding down gives 41 (1.71s, 15% short);
    // nearest gives 49 (2.04s), which is what a caller asking for 2s expects.
    expect(toValidFrameCount(48)).toBe(49);
    expect(toValidFrameCount(49)).toBe(49);
    // Still rounds down when that is genuinely nearer.
    expect(toValidFrameCount(44)).toBe(41);
  });
});

describe("provider selection", () => {
  it("prefers Agnes over Hugging Face when both keys are present", () => {
    const generator = createImageGenerator({
      agnesApiKey: "agnes",
      huggingFaceApiKey: "hf",
      imageGenerationEnabled: true,
    });
    expect(generator.name).toBe("agnes");
  });

  it("still falls back to the mock when generation is not enabled", () => {
    expect(createImageGenerator({ agnesApiKey: "agnes" }).name).toBe("mock");
    expect(createImageGenerator({ imageGenerationEnabled: true }).name).toBe("mock");
  });

  it("keeps video opt-in separately from images", () => {
    // An Agnes key alone must not switch on video: the free tier is 2 rpm and
    // a clip takes minutes, so enabling it by accident would stall the pipeline.
    expect(createVideoGenerator({ agnesApiKey: "agnes" }).name).toBe("mock");
    expect(createVideoGenerator({ agnesApiKey: "agnes", videoGenerationEnabled: true }).name).toBe("agnes");
    expect(createVideoGenerator({ videoGenerationEnabled: true }).name).toBe("mock");
  });
});
