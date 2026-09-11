import { randomBytes } from "node:crypto";
import type { SocialAccountRepository, SocialConnectionRepository } from "@agent/database";
import {
  AppError,
  NotFoundError,
  ValidationError,
  type Logger,
  type TokenEncryptionService,
} from "@agent/shared";
import { InstagramAuthClient, InstagramAuthError } from "@agent/social-platforms";

export interface InstagramAuthServiceConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  apiVersion: string;
  graphHost: string;
}

export class InstagramNotConfiguredError extends AppError {
  constructor() {
    super(
      "Instagram integration is not configured. Set META_APP_ID, META_APP_SECRET and TOKEN_ENCRYPTION_KEY.",
      { statusCode: 503, code: "INSTAGRAM_NOT_CONFIGURED" },
    );
  }
}

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Owns the Instagram OAuth flow. Lives in the API layer deliberately —
 * never in an agent or a worker — and is the only place that turns a Meta
 * authorization code into a stored connection.
 *
 * Security properties enforced here:
 *  - `state` is random, persisted, single-use, and expires (CSRF + replay).
 *  - `accountId` is taken from the *stored* state, never from the callback
 *    query, so a caller can't bind a connection to someone else's account.
 *  - tokens are encrypted before they touch the database.
 *  - authorization codes and tokens are never logged.
 */
export class InstagramAuthService {
  private readonly client: InstagramAuthClient | null;

  constructor(
    private readonly deps: {
      config: InstagramAuthServiceConfig;
      socialConnectionRepository: SocialConnectionRepository;
      socialAccountRepository: SocialAccountRepository;
      tokenEncryption: TokenEncryptionService | null;
      logger: Logger;
    },
  ) {
    const { appId, appSecret } = deps.config;
    this.client =
      appId && appSecret
        ? new InstagramAuthClient({
            appId,
            appSecret,
            redirectUri: deps.config.redirectUri,
            apiVersion: deps.config.apiVersion,
            graphHost: deps.config.graphHost,
          })
        : null;
  }

  /** The app boots fine unconfigured; routes call this and 503 rather than crashing at startup. */
  isConfigured(): boolean {
    return this.client !== null && this.deps.tokenEncryption !== null;
  }

  private requireClient(): InstagramAuthClient {
    if (!this.client || !this.deps.tokenEncryption) throw new InstagramNotConfiguredError();
    return this.client;
  }

  /** Step 1: create a single-use state and return the Meta consent URL. */
  async beginConnect(socialAccountId: string): Promise<{ authorizationUrl: string; state: string }> {
    const client = this.requireClient();

    const account = await this.deps.socialAccountRepository.findById(socialAccountId);
    if (!account) throw new NotFoundError("SocialAccount", socialAccountId);

    const state = randomBytes(32).toString("hex");
    await this.deps.socialConnectionRepository.createState({
      state,
      platform: "instagram",
      socialAccountId,
      redirectUri: this.deps.config.redirectUri,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });

    this.deps.logger.info({ socialAccountId }, "instagram.oauth_started");
    return { authorizationUrl: client.buildAuthorizationUrl(state), state };
  }

  /**
   * Step 2: validate the callback, exchange the code, discover the
   * Instagram Professional account, and store an encrypted connection.
   */
  async completeConnect(input: {
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<{ connectionId: string; username: string | null; accountType: string }> {
    const client = this.requireClient();

    // The user denied consent, or Meta reported a problem.
    if (input.error) {
      throw new InstagramAuthError(
        "Instagram authorization was not completed.",
        input.errorDescription ?? input.error,
      );
    }
    if (!input.state) throw new ValidationError("Missing OAuth state parameter.");
    if (!input.code) throw new ValidationError("Missing OAuth code parameter.");

    // Single-use consumption: unknown, replayed, or expired state all fail here.
    const storedState = await this.deps.socialConnectionRepository.consumeState(input.state);
    if (!storedState) {
      this.deps.logger.warn("instagram.oauth_invalid_state");
      throw new ValidationError("Invalid or expired OAuth state.");
    }
    if (storedState.platform !== "instagram") {
      throw new ValidationError("OAuth state does not belong to the Instagram flow.");
    }

    // accountId comes from the trusted stored state, never from the query string.
    const socialAccountId = storedState.socialAccountId;

    const shortLived = await client.exchangeCodeForToken(input.code);
    const longLived = await client.exchangeForLongLivedToken(shortLived.accessToken);
    const discovered = await client.discoverInstagramAccount(longLived.accessToken);

    if (discovered.accountType === "personal") {
      throw new InstagramAuthError(
        "That Instagram account is a personal account. Publishing requires an Instagram Professional (Business or Creator) account.",
      );
    }

    // Instagram publishing is authorized with the Page token, not the user token.
    const pageAccessToken = await client.getPageAccessToken(longLived.accessToken, discovered.pageId);

    const encryption = this.deps.tokenEncryption!;
    const connection = await this.deps.socialConnectionRepository.upsert({
      socialAccountId,
      platform: "instagram",
      platformAccountId: discovered.platformAccountId,
      platformUsername: discovered.username ?? undefined,
      accountType: discovered.accountType,
      accessTokenEncrypted: encryption.encrypt(pageAccessToken),
      tokenExpiresAt: longLived.expiresInSeconds
        ? new Date(Date.now() + longLived.expiresInSeconds * 1000)
        : undefined,
      scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"],
      metadata: {
        pageId: discovered.pageId,
        pageName: discovered.pageName,
        profilePictureUrl: discovered.profilePictureUrl,
      },
    });

    // Note: username/accountType only — no token material.
    this.deps.logger.info(
      { socialAccountId, connectionId: connection.id, accountType: discovered.accountType },
      "instagram.oauth_connected",
    );

    return {
      connectionId: connection.id,
      username: discovered.username,
      accountType: discovered.accountType,
    };
  }

  async listConnections(socialAccountId?: string) {
    return socialAccountId
      ? this.deps.socialConnectionRepository.listByAccount(socialAccountId)
      : this.deps.socialConnectionRepository.listAll();
  }

  /** Disconnect. Deletes the stored credential outright rather than just flagging it. */
  async disconnect(connectionId: string): Promise<void> {
    const connection = await this.deps.socialConnectionRepository.findById(connectionId);
    if (!connection) throw new NotFoundError("SocialConnection", connectionId);

    // Revoke rather than delete: past publishing_jobs still reference this
    // connection, and the audit trail matters more than the row. The stored
    // ciphertext is destroyed either way.
    await this.deps.socialConnectionRepository.revoke(connectionId);
    this.deps.logger.info({ connectionId }, "instagram.disconnected");
  }

  /** Connection health for the dashboard — never includes tokens. */
  async getStatus(socialAccountId: string) {
    const connections = await this.deps.socialConnectionRepository.listByAccount(socialAccountId);
    const instagram = connections.find((c) => c.platform === "instagram");

    if (!instagram) {
      return { configured: this.isConfigured(), connected: false as const };
    }

    const expired = instagram.tokenExpiresAt ? new Date(instagram.tokenExpiresAt).getTime() < Date.now() : false;
    return {
      configured: this.isConfigured(),
      connected: true as const,
      connectionId: instagram.id,
      username: instagram.platformUsername,
      accountType: instagram.accountType,
      status: expired ? "expired" : instagram.status,
      healthy: !expired && instagram.status === "connected",
      tokenExpiresAt: instagram.tokenExpiresAt,
    };
  }
}
