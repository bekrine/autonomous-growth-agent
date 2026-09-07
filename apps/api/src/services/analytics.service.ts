import type { AnalyticsRepository } from "@agent/database";

export class AnalyticsService {
  constructor(private readonly repo: AnalyticsRepository) {}

  async getForAccount(accountId: string) {
    return this.repo.listForAccount(accountId);
  }
}
