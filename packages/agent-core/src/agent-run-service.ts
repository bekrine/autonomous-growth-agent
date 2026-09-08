import type {
  AgentProfileRepository,
  AgentRunRepository,
  ContentRepository,
  ResearchRepository,
  StrategyRepository,
} from "@agent/database";
import { NotFoundError } from "@agent/shared";
import type { AgentOrchestrator } from "./orchestrator.js";

export interface AgentRunServiceDeps {
  orchestrator: AgentOrchestrator;
  agentRunRepository: AgentRunRepository;
  researchRepository: ResearchRepository;
  strategyRepository: StrategyRepository;
  contentRepository: ContentRepository;
  agentProfileRepository: AgentProfileRepository;
}

/**
 * The application service between a caller (Express controller, or the
 * BullMQ agent-run job processor) and the orchestrator:
 *   Controller/Worker -> AgentRunService -> AgentOrchestrator
 * Framework-agnostic on purpose — both apps/api and workers/agent-worker
 * import this exact class (via buildAgentSystem) so "run an agent run" has
 * one implementation regardless of which path triggered it. Owns nothing
 * the orchestrator doesn't already persist — it only re-reads the
 * persisted rows for a run to shape a structured result.
 */
export class AgentRunService {
  constructor(private readonly deps: AgentRunServiceDeps) {}

  async startRun(accountId: string) {
    const outcome = await this.deps.orchestrator.executeRun(accountId);
    const response = await this.buildRunResponse(outcome.runId, outcome.status, accountId);
    return { ...response, error: outcome.error };
  }

  /** Resumes/retries an existing run — used by the BullMQ job processor for redelivered jobs. */
  async resumeRun(accountId: string, runId: string) {
    const outcome = await this.deps.orchestrator.executeRun(accountId, { runId });
    const response = await this.buildRunResponse(outcome.runId, outcome.status, accountId);
    return { ...response, error: outcome.error };
  }

  async listRuns() {
    return this.deps.agentRunRepository.listRecent();
  }

  async getRun(runId: string) {
    const run = await this.deps.agentRunRepository.findById(runId);
    if (!run) throw new NotFoundError("AgentRun", runId);

    const [response, decisions, actions] = await Promise.all([
      this.buildRunResponse(runId, run.status, run.socialAccountId),
      this.deps.agentRunRepository.listDecisions(runId),
      this.deps.agentRunRepository.listActions(runId),
    ]);

    return { ...response, decisions, actions };
  }

  private async buildRunResponse(runId: string, status: string, accountId: string) {
    const [research, ideas, versionForRun] = await Promise.all([
      this.deps.researchRepository.listByRunId(runId),
      this.deps.contentRepository.listIdeasByRunId(runId),
      this.deps.strategyRepository.findVersionByRunId(runId),
    ]);

    const strategy = versionForRun
      ? this.toStrategySnapshot(versionForRun)
      : await this.currentStrategySnapshot(accountId);

    return {
      runId,
      status,
      research: research.map((r) => ({
        topic: r.topic,
        relevanceScore: Number(r.relevanceScore),
        audienceInterestScore: Number(r.audienceInterestScore),
        competitionScore: Number(r.competitionScore),
        rationale: r.rationale,
        sourceType: r.sourceType,
      })),
      strategy,
      contentIdeas: ideas.map((i) => ({
        title: i.title,
        format: i.format,
        contentPillar: i.contentPillar,
        targetAudience: i.targetAudience,
        hook: i.hook,
        objective: i.objective,
        priorityScore: i.priorityScore ? Number(i.priorityScore) : null,
      })),
    };
  }

  private toStrategySnapshot(version: { versionNumber: number; summary: string; content: unknown; createdAt: Date }) {
    return {
      versionNumber: version.versionNumber,
      summary: version.summary,
      data: version.content,
      createdAt: version.createdAt.toISOString(),
    };
  }

  private async currentStrategySnapshot(accountId: string) {
    const profile = await this.deps.agentProfileRepository.findBySocialAccountId(accountId);
    if (!profile) return null;
    const [strategy] = await this.deps.strategyRepository.findByAgentProfileId(profile.id);
    if (!strategy) return null;
    const latest = await this.deps.strategyRepository.latestVersion(strategy.id);
    return latest ? this.toStrategySnapshot(latest) : null;
  }
}
