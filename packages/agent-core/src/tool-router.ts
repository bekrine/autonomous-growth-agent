import type { PolicyEngine } from "@agent/policies";
import type { Tool, ToolResult } from "./tool.js";

/**
 * Sits between agents and tool execution:
 *   Agent -> ToolRouter -> PolicyEngine -> Tool.execute()
 * This is the single choke point that guarantees no agent can bypass the
 * policy layer, because agents only ever hold a reference to the router,
 * never to a raw Tool instance.
 */
export class ToolRouter {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();

  constructor(
    tools: Tool<unknown, unknown>[],
    private readonly policyEngine: PolicyEngine,
  ) {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  async call<TInput, TOutput>(
    toolName: string,
    accountId: string,
    input: TInput,
  ): Promise<ToolResult<TOutput>> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { success: false, error: `Unknown tool: ${toolName}` };
    }

    const policyResult = await this.policyEngine.evaluate({
      accountId,
      actionType: toolName,
      payload: (input as Record<string, unknown>) ?? {},
    });

    if (!policyResult.allowed) {
      return { success: false, error: policyResult.reason ?? "Denied by policy" };
    }

    return tool.execute(input) as Promise<ToolResult<TOutput>>;
  }
}
