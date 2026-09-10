import { AppError } from "@agent/shared";

export interface InstagramOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  apiVersion: string;
  graphHost: string;
  fetchImpl?: typeof fetch;
}

/**
 * Permissions for the Facebook Login flow, which is what reaches an
 * Instagram Professional account linked to a Facebook Page:
 *   instagram_basic            — read the IG account
 *   instagram_content_publish  — create/publish media
 *   pages_show_list /
 *   pages_read_engagement      — discover the Page the IG account is linked to
 * `instagram_content_publish` requires Meta App Review before it can be used
 * by non-developers; app admins/developers/testers can use it beforehand.
 */
export const INSTAGRAM_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
] as const;

export class InstagramAuthError extends AppError {
  constructor(message: string, detail?: string) {
    super(message, { statusCode: 400, code: "INSTAGRAM_AUTH_ERROR", details: detail });
  }
}

export interface DiscoveredInstagramAccount {
  platformAccountId: string;
  username: string | null;
  accountType: "business" | "creator" | "personal" | "unknown";
  pageId: string;
  pageName: string | null;
  profilePictureUrl: string | null;
}

/**
 * Meta OAuth + Instagram account discovery. Kept in the platform package so
 * no Meta-specific request shape leaks into the API layer — the API's
 * InstagramAuthService orchestrates state/persistence and calls this.
 *
 * Nothing here logs codes or tokens; callers receive values and are
 * responsible for encrypting them at rest.
 */
export class InstagramAuthClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: InstagramOAuthConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** The URL the browser is redirected to in order to grant access. */
  buildAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.appId,
      redirect_uri: this.config.redirectUri,
      state,
      scope: INSTAGRAM_SCOPES.join(","),
      response_type: "code",
    });
    return `https://www.facebook.com/${this.config.apiVersion}/dialog/oauth?${params.toString()}`;
  }

  /** Exchanges the one-time code for a short-lived user access token. */
  async exchangeCodeForToken(code: string): Promise<{ accessToken: string; expiresInSeconds?: number }> {
    const params = new URLSearchParams({
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      redirect_uri: this.config.redirectUri,
      code,
    });

    const body = await this.request<{ access_token?: string; expires_in?: number }>(
      `oauth/access_token?${params.toString()}`,
    );
    if (!body.access_token) throw new InstagramAuthError("Meta did not return an access token.");
    return { accessToken: body.access_token, expiresInSeconds: body.expires_in };
  }

  /**
   * Upgrades a short-lived token (≈1h) to a long-lived one (≈60 days).
   * Without this the connection would break almost immediately.
   */
  async exchangeForLongLivedToken(shortLivedToken: string): Promise<{ accessToken: string; expiresInSeconds?: number }> {
    const params = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      fb_exchange_token: shortLivedToken,
    });

    const body = await this.request<{ access_token?: string; expires_in?: number }>(
      `oauth/access_token?${params.toString()}`,
    );
    if (!body.access_token) throw new InstagramAuthError("Meta did not return a long-lived access token.");
    return { accessToken: body.access_token, expiresInSeconds: body.expires_in };
  }

  /**
   * Finds the Instagram Professional account behind the granted Pages.
   * A Page without `instagram_business_account` means the user linked no
   * professional IG account — reported clearly rather than failing opaquely.
   */
  async discoverInstagramAccount(accessToken: string): Promise<DiscoveredInstagramAccount> {
    const pages = await this.request<{
      data?: {
        id: string;
        name?: string;
        access_token?: string;
        instagram_business_account?: { id: string };
      }[];
    }>(`me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(accessToken)}`);

    const pageWithIg = pages.data?.find((page) => page.instagram_business_account?.id);
    if (!pageWithIg?.instagram_business_account) {
      throw new InstagramAuthError(
        "No Instagram Professional account was found. Link an Instagram Business or Creator account to a Facebook Page, then reconnect.",
      );
    }

    const igId = pageWithIg.instagram_business_account.id;
    const profile = await this.request<{
      id: string;
      username?: string;
      account_type?: string;
      profile_picture_url?: string;
    }>(`${igId}?fields=id,username,profile_picture_url&access_token=${encodeURIComponent(accessToken)}`);

    return {
      platformAccountId: igId,
      username: profile.username ?? null,
      // The Pages-linked discovery path only surfaces professional accounts;
      // treat as business unless Meta says otherwise.
      accountType: normalizeAccountType(profile.account_type),
      pageId: pageWithIg.id,
      pageName: pageWithIg.name ?? null,
      profilePictureUrl: profile.profile_picture_url ?? null,
    };
  }

  /**
   * Page access token for the linked Page. Instagram publishing calls are
   * authorized with this rather than the user token.
   */
  async getPageAccessToken(userAccessToken: string, pageId: string): Promise<string> {
    const body = await this.request<{ access_token?: string }>(
      `${pageId}?fields=access_token&access_token=${encodeURIComponent(userAccessToken)}`,
    );
    if (!body.access_token) {
      throw new InstagramAuthError("Could not obtain a Page access token for the linked Facebook Page.");
    }
    return body.access_token;
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.config.graphHost.replace(/\/$/, "")}/${this.config.apiVersion}/${path.replace(/^\//, "")}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "GET" });
    } catch (error) {
      throw new InstagramAuthError(
        "Could not reach Meta to complete the connection.",
        error instanceof Error ? error.message : String(error),
      );
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }

    if (!response.ok) {
      const detail = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`;
      // `detail` goes to logs/DB; the message stays user-safe and never echoes the code or token.
      throw new InstagramAuthError("Meta rejected the connection request.", detail);
    }

    return body as T;
  }
}

function normalizeAccountType(raw: string | undefined): DiscoveredInstagramAccount["accountType"] {
  switch ((raw ?? "").toUpperCase()) {
    case "BUSINESS":
      return "business";
    case "CREATOR":
    case "MEDIA_CREATOR":
      return "creator";
    case "PERSONAL":
      return "personal";
    default:
      return "business";
  }
}
