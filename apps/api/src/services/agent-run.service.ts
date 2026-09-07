import type { AgentRunRepository } from "@agent/database";
import type { AgentOrchestrator } from "@agent/agent-core";
import { NotFoundError } from "@agent/shared";

export class AgentRunService {
  constructor(
    private readonly orchestrator: AgentOrchestrator,
    private readonly repo: AgentRunRepository,
  ) {}

  async startRun(accountId: string) {
    return this.orchestrator.executeRun(accountId);
  }

  async listRuns() {
    return this.repo.listRecent();
  }

  async getRun(runId: string) {
    const run = await this.repo.findById(runId);
    if (!run) throw new NotFoundError("AgentRun", runId);
    const [decisions, actions] = await Promise.all([
      this.repo.listDecisions(runId),
      this.repo.listActions(runId),
    ]);
    return { run, decisions, actions };
  }
}
