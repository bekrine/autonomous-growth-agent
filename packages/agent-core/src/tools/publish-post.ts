import type { Tool } from "../tool.js";
import type { PublishingService } from "../publishing/publishing-service.js";

export interface PublishPostToolInput {
  contentPostId: string;
  socialConnectionId: string;
  /** Read by ContentApprovalPolicy/PublishableContentPolicy before this tool ever runs. */
  contentStatus?: string;
  agentRunId?: string;
}

export interface PublishPostToolOutput {
  accepted: boolean;
  publishingJobId?: string;
  status?: string;
  reason?: string;
}

/**
 * The agent's route to publishing. It only ever *enqueues* — the agent never
 * waits on Meta's asynchronous media processing, and never touches the Meta
 * SDK. The real call happens later in the publishing worker.
 *
 *   Agent -> ToolRouter -> Policy -> PublishingService -> Queue -> Worker -> Adapter
 *
 * Note the enqueue path runs the full publishing policy set again inside
 * PublishingService (including AutoPublishPolicy, which blocks
 * agent-initiated publishing while AUTO_PUBLISH_ENABLED is false).
 */
export class PublishPostTool implements Tool<PublishPostToolInput, PublishPostToolOutput> {
  readonly name = "publishPost";
  readonly description = "Queue an approved content post for publishing to its connected social platform.";

  constructor(private readonly publishingService: PublishingService) {}

  async execute(input: PublishPostToolInput) {
    const result = await this.publishingService.enqueue({
      contentPostId: input.contentPostId,
      socialConnectionId: input.socialConnectionId,
      initiatedBy: "agent",
      agentRunId: input.agentRunId,
    });

    if (!result.accepted) {
      return { success: false, error: result.reason ?? "Publishing was not accepted.", data: result };
    }

    return {
      success: true,
      data: {
        accepted: true,
        publishingJobId: result.publishingJobId,
        status: result.status,
      },
    };
  }
}
