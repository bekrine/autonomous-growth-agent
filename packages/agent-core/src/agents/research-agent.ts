import type { Agent, AgentContext, AgentResult } from "../types.js";
import type { SearchWebInput, SearchWebResult } from "../tools/search-web.js";
import type { GetAccountInput, GetAccountOutput } from "../tools/get-account.js";

/**
 * Researches the account's niche/audience/competitors. For this phase it
 * runs a single mock search and records the finding as a decision — the
 * real implementation will fan out into multiple searches/trend sources.
 */
export class ResearchAgent implements Agent {
  readonly name = "research" as const;

  async run(context: AgentContext): Promise<AgentResult> {
    const accountResult = await context.tools.call<GetAccountInput, GetAccountOutput>(
      "getAccount",
      context.accountId,
      { accountId: context.accountId },
    );

    if (!accountResult.success || !accountResult.data) {
      return {
        decisions: [
          { decision: "research_failed", reason: accountResult.error ?? "Account not found" },
        ],
        actions: [{ actionType: "getAccount", status: "failed", result: { error: accountResult.error } }],
      };
    }

    const account = accountResult.data;
    const searchResult = await context.tools.call<SearchWebInput, SearchWebResult>(
      "searchWeb",
      context.accountId,
      { query: `${account.platform} content trends for ${account.displayName}` },
    );

    return {
      decisions: [
        {
          decision: "research_completed",
          reason: `Gathered ${searchResult.data?.results.length ?? 0} research result(s) for account ${account.displayName}`,
          metadata: { platform: account.platform },
        },
      ],
      actions: [
        { actionType: "getAccount", status: "succeeded", result: account },
        { actionType: "searchWeb", status: searchResult.success ? "succeeded" : "failed", result: searchResult.data },
      ],
      data: { account, research: searchResult.data },
    };
  }
}
