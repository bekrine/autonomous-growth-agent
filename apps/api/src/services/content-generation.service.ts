import type { AgentProfileRepository, ContentRepository } from "@agent/database";
import type { AgentRunService } from "@agent/agent-core";
import { NotFoundError } from "@agent/shared";

/**
 * Resolves the accountId a content idea belongs to (idea -> agent_profile
 * -> social_account) and delegates everything else to AgentRunService —
 * the same framework-agnostic service the queue processor uses, so
 * "generate content for an idea" has one implementation regardless of
 * which path triggered it.
 */
export class ContentGenerationService {
  constructor(
    private readonly agentRunService: AgentRunService,
    private readonly contentRepository: ContentRepository,
    private readonly agentProfileRepository: AgentProfileRepository,
  ) {}

  async generate(contentIdeaId: string) {
    const accountId = await this.resolveAccountIdForIdea(contentIdeaId);
    return this.agentRunService.generateContent(accountId, contentIdeaId);
  }

  async getContent(contentPostId: string) {
    return this.agentRunService.getContent(contentPostId);
  }

  /**
   * Resolves the content post for an idea. Queued generation returns only a
   * job id, so a caller that wants to watch progress needs a way to find the
   * post the worker is building — this is it. Returns null until the worker
   * has created it.
   */
  async getContentForIdea(contentIdeaId: string) {
    const post = await this.contentRepository.findPostByIdeaId(contentIdeaId);
    if (!post) return null;
    return this.agentRunService.getContent(post.id);
  }

  async getVersions(contentPostId: string) {
    return this.agentRunService.getContentVersions(contentPostId);
  }

  /** Review only ever runs as part of generation — this returns the latest recorded review for API symmetry with the brief's endpoint list. */
  async getLatestReview(contentPostId: string) {
    const review = await this.agentRunService.getLatestReview(contentPostId);
    if (!review) throw new NotFoundError("ContentReview", contentPostId);
    return review;
  }

  async resolveAccountIdForIdea(contentIdeaId: string): Promise<string> {
    const idea = await this.contentRepository.findIdeaById(contentIdeaId);
    if (!idea) throw new NotFoundError("ContentIdea", contentIdeaId);
    const profile = await this.agentProfileRepository.findById(idea.agentProfileId);
    if (!profile) throw new NotFoundError("AgentProfile", idea.agentProfileId);
    return profile.socialAccountId;
  }
}
