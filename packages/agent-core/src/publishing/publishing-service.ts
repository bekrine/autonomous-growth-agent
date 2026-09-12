import type {
  AgentRunRepository,
  ContentGenerationRepository,
  ContentRepository,
  Database,
  OutboxRepository,
  PublishingJobRepository,
  SocialConnectionRepository,
} from "@agent/database";
import {
  ContentRepository as ContentRepositoryClass,
  OutboxRepository as OutboxRepositoryClass,
  PublishingJobRepository as PublishingJobRepositoryClass,
} from "@agent/database";
import {
  isRetryablePublishingError,
  NotFoundError,
  ValidationError,
  type Logger,
  type PublishingErrorCode,
  type PublishPostKind,
  type SocialPlatformName,
  type TokenEncryptionService,
} from "@agent/shared";
import type { PolicyEngine } from "@agent/policies";
import { PUBLISH_ACTION } from "@agent/policies";
import {
  PublishingError,
  redactUrl,
  validateInstagramMedia,
  type PublishMediaItem,
  type SocialPlatformRegistry,
} from "@agent/social-platforms";
import type { StoredAssetMediaResolver } from "./public-media-resolver.js";
import { normalizeContentFormat } from "../prompts/content-creator/schema.js";

export interface PublishingServiceDeps {
  db: Database;
  contentRepository: ContentRepository;
  contentGenerationRepository: ContentGenerationRepository;
  publishingJobRepository: PublishingJobRepository;
  socialConnectionRepository: SocialConnectionRepository;
  agentRunRepository: AgentRunRepository;
  outboxRepository: OutboxRepository;
  policyEngine: PolicyEngine;
  platforms: SocialPlatformRegistry;
  mediaResolver: StoredAssetMediaResolver;
  tokenEncryption: TokenEncryptionService | null;
  logger: Logger;
  maxAttempts: number;
}

export interface EnqueueResult {
  accepted: boolean;
  publishingJobId?: string;
  status?: string;
  reason?: string;
  /** Set when the content was already published — the caller gets the existing post, not a duplicate. */
  externalPostId?: string;
}

export interface PublishOutcome {
  status: "published" | "failed" | "skipped";
  externalPostId?: string;
  errorCode?: PublishingErrorCode;
  error?: string;
}

/**
 * Owns the entire publishing workflow. Both the API (manual publish /
 * schedule) and the publishing worker call into this — the worker is only
 * job plumbing, exactly like the Phase 2/3 processors.
 *
 * Two distinct phases:
 *   enqueue()  — validate + policy-check + create a durable job + outbox event
 *   execute()  — called by the worker: re-check policy, publish, persist result
 *
 * Policy is checked in BOTH: at enqueue for fast feedback, and again at
 * execute because a scheduled job may sit for hours during which the kill
 * switch could flip or the connection could expire.
 */
export class PublishingService {
  constructor(private readonly deps: PublishingServiceDeps) {}

  /**
   * Creates (or returns) a publishing job for a content post. Never publishes
   * inline — the actual Meta call always happens in the worker so the caller
   * isn't blocked on Instagram's async media processing.
   */
  async enqueue(input: {
    contentPostId: string;
    socialConnectionId: string;
    scheduledFor?: Date;
    initiatedBy: "human" | "agent";
    agentRunId?: string;
  }): Promise<EnqueueResult> {
    const { contentRepository, publishingJobRepository, logger } = this.deps;

    const post = await contentRepository.findPostById(input.contentPostId);
    if (!post) throw new NotFoundError("ContentPost", input.contentPostId);

    // Hard idempotency guard: if this post already published, hand back the
    // existing external id rather than creating another job.
    const alreadyPublished = await publishingJobRepository.findSucceededForContentPost(post.id);
    if (alreadyPublished) {
      return {
        accepted: false,
        publishingJobId: alreadyPublished.id,
        status: alreadyPublished.status,
        externalPostId: alreadyPublished.externalPostId ?? undefined,
        reason: "This content has already been published.",
      };
    }

    const context = await this.buildPolicyContext({
      post,
      socialConnectionId: input.socialConnectionId,
      initiatedBy: input.initiatedBy,
      scheduledFor: input.scheduledFor,
      jobStatus: "queued",
      // A future schedule is legitimate at enqueue time; only execute() enforces timing.
      ignoreSchedule: true,
    });

    const decision = await this.deps.policyEngine.evaluate(context.policyContext);
    if (!decision.allowed) {
      logger.warn(
        { contentPostId: post.id, reason: decision.reason, initiatedBy: input.initiatedBy },
        "publishing.enqueue_denied",
      );
      return { accepted: false, reason: decision.reason };
    }

    const generationId = context.generation?.id;
    // Stable per (post, generation): a repeated request maps to the same key,
    // and the UNIQUE constraint makes the database the final arbiter.
    const idempotencyKey = `publish:${post.id}:${generationId ?? "none"}`;
    const status = input.scheduledFor ? "scheduled" : "queued";

    const { job, created } = await publishingJobRepository.createIfAbsent({
      contentPostId: post.id,
      contentGenerationId: generationId,
      socialConnectionId: input.socialConnectionId,
      platform: context.connection.platform as SocialPlatformName,
      idempotencyKey,
      scheduledFor: input.scheduledFor,
      status,
    });

    if (!created) {
      return {
        accepted: false,
        publishingJobId: job.id,
        status: job.status,
        externalPostId: job.externalPostId ?? undefined,
        reason: "A publishing job already exists for this content.",
      };
    }

    // Outbox + status update commit together: the job is never visible as
    // queued without a corresponding event to actually run it.
    await this.deps.db.transaction(async (tx) => {
      await new ContentRepositoryClass(tx).updatePostStatus(post.id, input.scheduledFor ? "scheduled" : "queued");
      await new OutboxRepositoryClass(tx).enqueue({
        aggregateType: "publishing",
        aggregateId: job.id,
        eventType: "publish-content",
        payload: { publishingJobId: job.id, delayMs: input.scheduledFor ? Math.max(0, input.scheduledFor.getTime() - Date.now()) : 0 },
      });
    });

    if (input.agentRunId) {
      await this.recordAgentAction(input.agentRunId, post.id, job.id, "queued");
    }

    logger.info(
      { contentPostId: post.id, publishingJobId: job.id, status, scheduledFor: input.scheduledFor?.toISOString() },
      "publishing.job_enqueued",
    );

    return { accepted: true, publishingJobId: job.id, status };
  }

  /**
   * Performs the real publish. Called only by the publishing worker.
   * Re-runs every policy check, because a scheduled job may have been
   * cancelled or the kill switch flipped since it was enqueued.
   */
  async execute(publishingJobId: string): Promise<PublishOutcome> {
    const { publishingJobRepository, contentRepository, logger } = this.deps;
    const startedAt = Date.now();

    const existing = await publishingJobRepository.findById(publishingJobId);
    if (!existing) throw new NotFoundError("PublishingJob", publishingJobId);

    if (existing.status === "published" && existing.externalPostId) {
      logger.info({ publishingJobId }, "publishing.already_published_skip");
      return { status: "skipped", externalPostId: existing.externalPostId };
    }

    // Conditional claim: a cancelled job (or one another worker took) matches
    // nothing and we stop here without publishing.
    const job = await publishingJobRepository.claimForPublishing(publishingJobId);
    if (!job) {
      logger.info({ publishingJobId, status: existing.status }, "publishing.not_claimable_skip");
      return { status: "skipped" };
    }

    const post = await contentRepository.findPostById(job.contentPostId);
    if (!post) throw new NotFoundError("ContentPost", job.contentPostId);

    await publishingJobRepository.incrementAttempts(job.id);
    const attempt = job.attempts + 1;

    try {
      const context = await this.buildPolicyContext({
        post,
        socialConnectionId: job.socialConnectionId!,
        initiatedBy: "human",
        scheduledFor: job.scheduledFor ?? undefined,
        jobStatus: job.status,
      });

      const decision = await this.deps.policyEngine.evaluate(context.policyContext);
      if (!decision.allowed) {
        // A policy denial is never retryable — the condition won't change by itself.
        return this.finalizeFailure(job.id, post.id, "POLICY_DENIED", decision.reason ?? "Denied by policy", attempt, startedAt, false);
      }

      const publisher = this.deps.platforms.getPublisher(context.connection.platform as SocialPlatformName);
      const accessToken = this.decryptToken(context.connection.accessTokenEncrypted);

      await contentRepository.updatePostStatus(post.id, "publishing");

      const outcome = await publisher.publish({
        platformAccountId: context.connection.platformAccountId,
        accessToken,
        kind: context.kind,
        caption: context.caption,
        altText: context.altText,
        media: context.media,
        existingContainerId: job.externalContainerId ?? undefined,
        // Persisted the moment it exists so a crash before media_publish is resumable.
        onContainerCreated: async (containerId) => {
          await publishingJobRepository.updateStatus(job.id, {
            status: "publishing",
            externalContainerId: containerId,
          });
          logger.info({ publishingJobId: job.id, containerId }, "publishing.container_created");
        },
      });

      const publishedAt = new Date(outcome.publishedAt);
      await publishingJobRepository.updateStatus(job.id, {
        status: "published",
        externalPostId: outcome.externalPostId,
        externalContainerId: outcome.externalContainerId ?? null,
        publishedAt,
        errorCode: null,
        lastError: null,
      });
      await contentRepository.updatePostStatus(post.id, "published");

      // Emits `content.published` through the same outbox the publish itself
      // used, so analytics collection is a reaction to a durable fact rather
      // than something the browser or a timer has to trigger. A crash right
      // here leaves the event pending, not lost.
      await new OutboxRepositoryClass(this.deps.db).enqueue({
        aggregateType: "analytics",
        aggregateId: post.id,
        eventType: "content.published",
        payload: {
          contentPostId: post.id,
          socialAccountId: post.socialAccountId,
          contentGenerationId: job.contentGenerationId,
          externalPostId: outcome.externalPostId,
          platform: job.platform ?? "instagram",
          publishedAt: publishedAt.toISOString(),
        },
      });

      logger.info(
        {
          publishingJobId: job.id,
          contentPostId: post.id,
          contentGenerationId: job.contentGenerationId,
          platform: job.platform,
          externalPostId: outcome.externalPostId,
          attempt,
          durationMs: Date.now() - startedAt,
          status: "published",
        },
        "publishing.published",
      );

      return { status: "published", externalPostId: outcome.externalPostId };
    } catch (error) {
      const code: PublishingErrorCode =
        error instanceof PublishingError ? error.publishingErrorCode : "UNKNOWN";
      const detail = error instanceof PublishingError ? error.providerDetail : undefined;
      const message = error instanceof Error ? error.message : String(error);

      return this.finalizeFailure(
        job.id,
        post.id,
        code,
        message,
        attempt,
        startedAt,
        isRetryablePublishingError(code),
        detail,
      );
    }
  }

  /** Cancels a job that has not started publishing yet. */
  async cancel(publishingJobId: string): Promise<{ cancelled: boolean; reason?: string }> {
    const job = await this.deps.publishingJobRepository.findById(publishingJobId);
    if (!job) throw new NotFoundError("PublishingJob", publishingJobId);

    const cancelled = await this.deps.publishingJobRepository.cancel(publishingJobId);
    if (!cancelled) {
      return { cancelled: false, reason: `Job is ${job.status} and can no longer be cancelled.` };
    }

    await this.deps.contentRepository.updatePostStatus(job.contentPostId, "ready_for_publishing");
    this.deps.logger.info({ publishingJobId }, "publishing.job_cancelled");
    return { cancelled: true };
  }

  async listJobs(limit = 100) {
    return this.deps.publishingJobRepository.listRecent(limit);
  }

  async getJob(publishingJobId: string) {
    const job = await this.deps.publishingJobRepository.findById(publishingJobId);
    if (!job) throw new NotFoundError("PublishingJob", publishingJobId);
    return job;
  }

  /** Records the outcome and decides whether another attempt is warranted. */
  private async finalizeFailure(
    jobId: string,
    contentPostId: string,
    code: PublishingErrorCode,
    message: string,
    attempt: number,
    startedAt: number,
    retryable: boolean,
    providerDetail?: string,
  ): Promise<PublishOutcome> {
    const canRetry = retryable && attempt < this.deps.maxAttempts;
    const status = canRetry ? "retry_scheduled" : "failed";

    await this.deps.publishingJobRepository.updateStatus(jobId, {
      status,
      errorCode: code,
      // Provider detail is kept server-side for debugging; the API surfaces `message`.
      lastError: providerDetail ? `${message} | ${providerDetail}` : message,
    });
    await this.deps.contentRepository.updatePostStatus(
      contentPostId,
      canRetry ? "queued" : "publish_failed",
    );

    this.deps.logger.error(
      {
        publishingJobId: jobId,
        contentPostId,
        attempt,
        errorCode: code,
        retryable: canRetry,
        durationMs: Date.now() - startedAt,
        status,
      },
      "publishing.failed",
    );

    return { status: "failed", errorCode: code, error: message };
  }

  /**
   * Loads everything the policies need and shapes the platform request.
   * Doing it here keeps the policies pure/synchronous and means the worker
   * never assembles publishing state itself.
   */
  private async buildPolicyContext(input: {
    post: { id: string; socialAccountId: string; status: string; currentGenerationVersion: number };
    socialConnectionId: string;
    initiatedBy: "human" | "agent";
    scheduledFor?: Date;
    jobStatus: string;
    ignoreSchedule?: boolean;
  }) {
    const { socialConnectionRepository, contentGenerationRepository, publishingJobRepository, mediaResolver } =
      this.deps;

    const connection = await socialConnectionRepository.findByIdWithSecrets(input.socialConnectionId);
    if (!connection) throw new NotFoundError("SocialConnection", input.socialConnectionId);

    const generation = await contentGenerationRepository.findLatestByPostId(input.post.id);
    const review = generation
      ? await contentGenerationRepository.findReviewByGenerationId(generation.id)
      : null;

    const payload = (generation?.payload ?? {}) as Record<string, unknown>;
    const kind = toPublishKind(generation?.format);
    const caption = String(payload.caption ?? "");
    const altText = payload.altText ? String(payload.altText) : undefined;

    const media: PublishMediaItem[] = generation ? await mediaResolver.resolveForGeneration(generation.id) : [];
    const mediaCheck = validateInstagramMedia(kind, media);

    const now = Date.now();
    const [publishedLastDay, publishedLastHour, lastPublished] = await Promise.all([
      publishingJobRepository.countPublishedSince(input.socialConnectionId, new Date(now - 24 * 60 * 60_000)),
      publishingJobRepository.countPublishedSince(input.socialConnectionId, new Date(now - 60 * 60_000)),
      publishingJobRepository.findLastPublished(input.socialConnectionId),
    ]);

    return {
      connection,
      generation,
      kind,
      caption,
      altText,
      media,
      policyContext: {
        accountId: input.post.socialAccountId,
        actionType: PUBLISH_ACTION,
        payload: {
          contentStatus: input.post.status,
          reviewApproved: review ? review.approved : undefined,
          connectionStatus: connection.status,
          connectionExpiresAt: connection.tokenExpiresAt?.toISOString(),
          accountType: connection.accountType,
          mediaValid: mediaCheck.valid,
          mediaIssue: mediaCheck.issues[0]?.message,
          publishedLastDay,
          publishedLastHour,
          lastPublishedAt: lastPublished?.publishedAt?.toISOString(),
          initiatedBy: input.initiatedBy,
          jobStatus: input.jobStatus,
          scheduledFor: input.ignoreSchedule ? undefined : input.scheduledFor?.toISOString(),
          platform: connection.platform,
          mediaUrls: media.map((m) => redactUrl(m.url)),
        },
      },
    };
  }

  private decryptToken(encrypted: string | null): string {
    if (!encrypted) {
      // A revoked connection has had its ciphertext destroyed. SocialConnectionPolicy
      // should already have denied this, so reaching here means state changed under us.
      throw new PublishingError(
        "AUTHENTICATION_FAILED",
        "This Instagram connection has been disconnected. Reconnect the account.",
      );
    }
    if (!this.deps.tokenEncryption) {
      throw new PublishingError(
        "AUTHENTICATION_FAILED",
        "Token encryption is not configured — set TOKEN_ENCRYPTION_KEY to publish.",
      );
    }
    try {
      return this.deps.tokenEncryption.decrypt(encrypted);
    } catch {
      // A wrong/rotated key or corrupted ciphertext will fail identically on
      // every retry, so classify it as permanent rather than letting it
      // masquerade as UNKNOWN (which is retryable) and burn all attempts.
      // The underlying error is deliberately not propagated — it must not
      // leak ciphertext or key material.
      throw new PublishingError(
        "AUTHENTICATION_FAILED",
        "The stored Instagram credential could not be read. Reconnect the account.",
        "token decryption failed",
      );
    }
  }

  /** Publishing is an agent action and must appear in the audit trail. */
  private async recordAgentAction(
    agentRunId: string,
    contentPostId: string,
    publishingJobId: string,
    result: string,
  ): Promise<void> {
    await this.deps.agentRunRepository.recordAction({
      agentRunId,
      actionType: "publish_content",
      status: "pending",
      // Metadata only — never tokens.
      payload: { contentId: contentPostId, publishingJobId, platform: "instagram" },
      result: { result },
    });
  }
}

/** Maps a stored generation format onto a platform-agnostic post kind. */
function toPublishKind(format: string | null | undefined): PublishPostKind {
  const normalized = normalizeContentFormat(format);
  return normalized === "reel" ? "reel" : normalized === "carousel" ? "carousel" : normalized === "text" ? "text" : "image";
}
