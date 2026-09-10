import type { PublishingErrorCode } from "@agent/shared";
import { PublishingError } from "../../publishing-types.js";

export interface GraphClientOptions {
  apiVersion: string;
  /** e.g. https://graph.facebook.com (or https://graph.instagram.com for Instagram Login). */
  host: string;
  fetchImpl?: typeof fetch;
}

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
  };
}

/**
 * Maps Meta's error codes onto our normalized codes. The distinction that
 * matters most is retryable vs. not: an expired token or missing permission
 * will fail identically forever, so it must not consume retry attempts.
 *
 * Meta error code reference:
 *  - 190: access token invalid/expired
 *  - 10, 200-299: permission errors
 *  - 4, 17, 32, 613: rate/throttle limits
 *  - 2207xxx: Instagram publishing media errors
 */
function classifyMetaError(status: number, body: MetaErrorBody): PublishingErrorCode {
  const code = body.error?.code;
  const subcode = body.error?.error_subcode;
  const message = (body.error?.message ?? "").toLowerCase();

  if (code === 190 || status === 401) return "AUTHENTICATION_FAILED";
  if (code === 10 || (typeof code === "number" && code >= 200 && code <= 299) || status === 403) {
    return "PERMISSION_DENIED";
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) return "RATE_LIMITED";

  // Instagram media-specific failures (2207xxx family) are about the media
  // itself — retrying the same URL will not help.
  if (typeof subcode === "number" && subcode >= 2207000 && subcode < 2208000) {
    if (subcode === 2207052 || message.includes("fetch") || message.includes("download")) {
      return "MEDIA_NOT_ACCESSIBLE";
    }
    return "MEDIA_INVALID";
  }
  if (message.includes("media") && (message.includes("format") || message.includes("aspect"))) {
    return "MEDIA_INVALID";
  }
  if (status >= 500) return "PLATFORM_ERROR";
  return "PLATFORM_ERROR";
}

/**
 * Thin HTTP client for the Meta Graph API. Owns URL construction, error
 * normalization, and the guarantee that access tokens are sent in the request
 * body/query but never returned, logged, or embedded in error messages.
 */
export class MetaGraphClient {
  private readonly apiVersion: string;
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GraphClientOptions) {
    this.apiVersion = options.apiVersion;
    this.host = options.host.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.host}/${this.apiVersion}/${path.replace(/^\//, "")}`;
  }

  async post<T>(path: string, params: Record<string, string>): Promise<T> {
    return this.request<T>("POST", path, params);
  }

  async get<T>(path: string, params: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  private async request<T>(method: "GET" | "POST", path: string, params: Record<string, string>): Promise<T> {
    const url = this.url(path);
    let response: Response;

    try {
      if (method === "GET") {
        const query = new URLSearchParams(params).toString();
        response = await this.fetchImpl(`${url}?${query}`, { method: "GET" });
      } else {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params).toString(),
        });
      }
    } catch (error) {
      // Network-level failure: transient, so classify as retryable.
      throw new PublishingError(
        "PLATFORM_ERROR",
        "Could not reach the Meta API",
        error instanceof Error ? error.message : String(error),
      );
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 500) };
    }

    if (!response.ok) {
      const metaBody = body as MetaErrorBody;
      const code = classifyMetaError(response.status, metaBody);
      // Provider detail is stored/logged, but the user-facing message stays generic.
      const detail = metaBody.error?.message ?? `HTTP ${response.status}`;
      throw new PublishingError(code, publicMessageFor(code), `[${response.status}] ${detail}`);
    }

    return body as T;
  }
}

/** User-facing text per error code — deliberately free of Meta internals. */
function publicMessageFor(code: PublishingErrorCode): string {
  switch (code) {
    case "AUTHENTICATION_FAILED":
      return "The Instagram connection is no longer valid. Reconnect the account.";
    case "PERMISSION_DENIED":
      return "The Instagram connection is missing a required permission.";
    case "RATE_LIMITED":
      return "Instagram's publishing rate limit was reached. Try again later.";
    case "MEDIA_NOT_ACCESSIBLE":
      return "Instagram could not download the media. The media URL must be publicly reachable.";
    case "MEDIA_INVALID":
      return "The media does not meet Instagram's format requirements.";
    default:
      return "Instagram rejected the request.";
  }
}
