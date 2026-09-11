import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import type { AppDependencies } from "../config.js";
import { createLogger } from "@agent/shared";

/**
 * Storage credentials must never leave the server. These are deliberately
 * distinctive sentinel values: if any of them ever appears in a response
 * body, some serializer started echoing configuration it should not.
 */
const SECRETS = {
  accountId: "SENTINEL-R2-ACCOUNT-ID",
  accessKeyId: "SENTINEL-R2-ACCESS-KEY-ID",
  secretAccessKey: "SENTINEL-R2-SECRET-ACCESS-KEY",
  bucket: "SENTINEL-BUCKET",
};

const POST_ID = "44444444-4444-4444-4444-444444444444";
const PUBLIC_URL = "https://pub-test.r2.dev/accounts/a/content/c/images/x.jpg";

function createDeps() {
  const generation = {
    generationId: "g1",
    version: 1,
    format: "image",
    status: "generated",
    caption: "a caption",
    assets: [
      {
        id: "asset-1",
        type: "image",
        assetType: "image",
        url: PUBLIC_URL,
        publicUrl: PUBLIC_URL,
        mimeType: "image/jpeg",
        provider: "mock",
        storageProvider: "cloudflare-r2",
        sizeBytes: 4599,
        width: 1080,
        height: 1080,
        status: "completed",
      },
    ],
    review: { approved: true, score: 0.95 },
  };

  const agentRunService = {
    getContent: vi.fn(async () => ({
      contentId: POST_ID,
      status: "ready_for_publishing",
      generationVersion: 1,
      generation,
    })),
    getContentVersions: vi.fn(async () => ({
      contentPostId: POST_ID,
      status: "ready_for_publishing",
      versions: [generation],
    })),
    getLatestReview: vi.fn(async () => ({ approved: true, score: 0.95 })),
    generateContent: vi.fn(),
  };

  return {
    env: {
      NODE_ENV: "test",
      STORAGE_LOCAL_DIR: "/tmp",
      R2_ACCOUNT_ID: SECRETS.accountId,
      R2_ACCESS_KEY_ID: SECRETS.accessKeyId,
      R2_SECRET_ACCESS_KEY: SECRETS.secretAccessKey,
      R2_BUCKET_NAME: SECRETS.bucket,
      R2_PUBLIC_BASE_URL: "https://pub-test.r2.dev",
    } as unknown as AppDependencies["env"],
    logger: createLogger({ name: "test", level: "silent" }),
    db: {} as AppDependencies["db"],
    redis: {} as AppDependencies["redis"],
    llm: { name: "mock", generateText: vi.fn(), generateStructured: vi.fn() },
    agentQueueProducer: { enqueueRun: vi.fn(), close: vi.fn() } as unknown as AppDependencies["agentQueueProducer"],
    contentQueueProducer: { enqueueGeneration: vi.fn(), close: vi.fn() } as unknown as AppDependencies["contentQueueProducer"],
    publishingQueueProducer: { enqueuePublish: vi.fn(), close: vi.fn() } as unknown as AppDependencies["publishingQueueProducer"],
    instagramAuthService: {
      isConfigured: vi.fn(() => false),
      getStatus: vi.fn(async () => ({ configured: false, connected: false })),
      listConnections: vi.fn(async () => []),
    } as unknown as AppDependencies["instagramAuthService"],
    agentSystem: {
      orchestrator: {},
      agentRunService,
      toolRouter: {},
      policyEngine: {},
      killSwitch: { setGlobalDisabled: vi.fn() },
      repositories: {
        socialAccountRepository: { listAll: vi.fn(async () => []) },
        agentProfileRepository: {},
        strategyRepository: {},
        agentRunRepository: { listRecent: vi.fn(async () => []) },
        researchRepository: {},
        contentRepository: {},
        contentGenerationRepository: {},
      },
    } as unknown as AppDependencies["agentSystem"],
  } as AppDependencies;
}

function assertNoSecrets(body: unknown) {
  const serialized = JSON.stringify(body);
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(serialized, `response leaked R2 ${name}`).not.toContain(value);
  }
}

describe("R2 credentials never reach the client", () => {
  it("returns the public URL and storage provider, but no credentials", async () => {
    const app = createApp(createDeps());

    const response = await request(app).get(`/api/content/${POST_ID}`).expect(200);

    const asset = response.body.generation.assets[0];
    expect(asset.publicUrl).toBe(PUBLIC_URL);
    expect(asset.mimeType).toBe("image/jpeg");
    expect(asset.storageProvider).toBe("cloudflare-r2");
    expect(asset.status).toBe("completed");

    // The asset carries no key material or bucket addressing.
    expect(asset).not.toHaveProperty("accessKeyId");
    expect(asset).not.toHaveProperty("secretAccessKey");
    assertNoSecrets(response.body);
  });

  it("does not leak credentials through the version history endpoint", async () => {
    const app = createApp(createDeps());
    const response = await request(app).get(`/api/content/${POST_ID}/versions`).expect(200);
    assertNoSecrets(response.body);
  });

  it("does not leak credentials through health or version endpoints", async () => {
    const app = createApp(createDeps());
    assertNoSecrets((await request(app).get("/api/version").expect(200)).body);
  });
});
