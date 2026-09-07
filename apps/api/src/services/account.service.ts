import type { SocialAccountRepository } from "@agent/database";
import type { SocialPlatformName } from "@agent/shared";

export interface CreateAccountRequest {
  userEmail: string;
  platform: SocialPlatformName;
  externalAccountId: string;
  displayName: string;
}

/** Business logic for social accounts lives here, not in the route handler. */
export class AccountService {
  constructor(private readonly repo: SocialAccountRepository) {}

  async listAccounts() {
    return this.repo.listAll();
  }

  async createAccount(input: CreateAccountRequest) {
    const userId = await this.repo.ensureDefaultUser(input.userEmail);
    return this.repo.create({
      userId,
      platform: input.platform,
      externalAccountId: input.externalAccountId,
      displayName: input.displayName,
    });
  }
}
