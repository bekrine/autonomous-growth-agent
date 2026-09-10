import { and, asc, eq } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { contentAssets, contentGenerations, contentReviews } from "../schema/index.js";

export interface CreateContentGenerationInput {
  contentPostId: string;
  versionNumber: number;
  attemptNumber: number;
  format: string;
  payload?: Record<string, unknown>;
  status: "generating" | "generated" | "generation_failed";
  errorMessage?: string;
  agentRunId?: string;
  llmProvider?: string;
  llmModel?: string;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface CreateContentReviewInput {
  contentGenerationId: string;
  approved: boolean;
  score: number;
  qualityScore: number;
  brandScore: number;
  safetyScore: number;
  issues: { type: string; message: string }[];
  warnings: string[];
  recommendedChanges: string[];
  agentRunId?: string;
}

export interface CreateContentAssetInput {
  contentGenerationId: string;
  assetType: "image" | "video";
  provider: string;
  status?: "requested" | "generating" | "completed" | "failed";
  storageKey?: string;
  url?: string;
  mimeType?: string;
  providerAssetId?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  errorMessage?: string;
}

export class ContentGenerationRepository {
  constructor(private readonly db: DrizzleClient) {}

  async createGeneration(input: CreateContentGenerationInput) {
    const [row] = await this.db.insert(contentGenerations).values(input).returning();
    return row;
  }

  /** Full version history for a post, oldest first — never deleted, never overwritten. */
  async listByPostId(contentPostId: string) {
    return this.db
      .select()
      .from(contentGenerations)
      .where(eq(contentGenerations.contentPostId, contentPostId))
      .orderBy(asc(contentGenerations.versionNumber));
  }

  async findByPostIdAndVersion(contentPostId: string, versionNumber: number) {
    const [row] = await this.db
      .select()
      .from(contentGenerations)
      .where(and(eq(contentGenerations.contentPostId, contentPostId), eq(contentGenerations.versionNumber, versionNumber)));
    return row ?? null;
  }

  async findLatestByPostId(contentPostId: string) {
    const versions = await this.listByPostId(contentPostId);
    return versions.length > 0 ? versions[versions.length - 1] : null;
  }

  async findById(id: string) {
    const [row] = await this.db.select().from(contentGenerations).where(eq(contentGenerations.id, id));
    return row ?? null;
  }

  async createReview(input: CreateContentReviewInput) {
    const [row] = await this.db
      .insert(contentReviews)
      .values({
        ...input,
        score: input.score.toString(),
        qualityScore: input.qualityScore.toString(),
        brandScore: input.brandScore.toString(),
        safetyScore: input.safetyScore.toString(),
      })
      .returning();
    return row;
  }

  async findReviewByGenerationId(contentGenerationId: string) {
    const [row] = await this.db
      .select()
      .from(contentReviews)
      .where(eq(contentReviews.contentGenerationId, contentGenerationId));
    return row ?? null;
  }

  async createAsset(input: CreateContentAssetInput) {
    const [row] = await this.db
      .insert(contentAssets)
      .values({ ...input, durationSeconds: input.durationSeconds?.toString() })
      .returning();
    return row;
  }

  async updateAssetStatus(
    id: string,
    update: {
      status: "requested" | "generating" | "completed" | "failed";
      provider?: string;
      storageKey?: string;
      url?: string;
      mimeType?: string;
      providerAssetId?: string;
      width?: number;
      height?: number;
      errorMessage?: string;
    },
  ) {
    const [row] = await this.db
      .update(contentAssets)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(contentAssets.id, id))
      .returning();
    return row;
  }

  async listAssetsByGenerationId(contentGenerationId: string) {
    return this.db.select().from(contentAssets).where(eq(contentAssets.contentGenerationId, contentGenerationId));
  }

  async findAssetById(id: string) {
    const [row] = await this.db.select().from(contentAssets).where(eq(contentAssets.id, id));
    return row ?? null;
  }
}
