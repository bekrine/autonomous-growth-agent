import type { SocialAccountRepository } from "@agent/database";
import { NotFoundError } from "@agent/shared";
import type { Tool } from "../tool.js";

export interface GetAccountInput {
  accountId: string;
}

export interface GetAccountOutput {
  id: string;
  platform: string;
  displayName: string;
  status: string;
}

export class GetAccountTool implements Tool<GetAccountInput, GetAccountOutput> {
  readonly name = "getAccount";
  readonly description = "Load the social account this run is operating on.";

  constructor(private readonly repo: SocialAccountRepository) {}

  async execute(input: GetAccountInput) {
    const account = await this.repo.findById(input.accountId);
    if (!account) {
      return { success: false, error: new NotFoundError("SocialAccount", input.accountId).message };
    }
    return {
      success: true,
      data: {
        id: account.id,
        platform: account.platform,
        displayName: account.displayName,
        status: account.status,
      },
    };
  }
}
