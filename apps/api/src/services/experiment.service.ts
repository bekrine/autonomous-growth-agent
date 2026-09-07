import type { ExperimentRepository } from "@agent/database";

export class ExperimentService {
  constructor(private readonly repo: ExperimentRepository) {}

  async getForAccount(accountId: string) {
    const rows = await this.repo.listForAccount(accountId);
    return rows.map((r) => r.experiment);
  }
}
