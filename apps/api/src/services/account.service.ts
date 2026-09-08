import type { AgentProfileRepository, SocialAccountRepository } from "@agent/database";
import type { SocialPlatformName } from "@agent/shared";

export interface CreateAccountRequest {
  userEmail: string;
  platform: SocialPlatformName;
  externalAccountId: string;
  displayName: string;
  /** Optional — when provided, an agent_profile (and goal, if given) is created in the same call so the account is immediately runnable. */
  niche?: string;
  targetAudience?: string;
  tone?: string;
  goalTitle?: string;
  goalMetric?: string;
}

/** Business logic for social accounts lives here, not in the route handler. */
export class AccountService {
  constructor(
    private readonly repo: SocialAccountRepository,
    private readonly agentProfileRepo: AgentProfileRepository,
  ) {}

  async listAccounts() {
    return this.repo.listAll();
  }

  async createAccount(input: CreateAccountRequest) {
    const userId = await this.repo.ensureDefaultUser(input.userEmail);
    const account = await this.repo.create({
      userId,
      platform: input.platform,
      externalAccountId: input.externalAccountId,
      displayName: input.displayName,
    });

    if (input.niche) {
      const profile = await this.agentProfileRepo.create({
        socialAccountId: account.id,
        niche: input.niche,
        audienceDescription: input.targetAudience,
        tone: input.tone,
      });

      if (input.goalTitle && input.goalMetric) {
        await this.agentProfileRepo.createGoal({
          agentProfileId: profile.id,
          title: input.goalTitle,
          metric: input.goalMetric,
        });
      }
    }

    return account;
  }
}
