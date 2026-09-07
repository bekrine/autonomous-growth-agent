import { describe, expect, it } from "vitest";
import { PolicyEngine, ContentApprovalPolicy } from "@agent/policies";
import { ToolRouter } from "../tool-router.js";
import type { Tool } from "../tool.js";

class EchoTool implements Tool<{ value: string }, { value: string }> {
  readonly name = "publish_post";
  readonly description = "test tool";
  async execute(input: { value: string }) {
    return { success: true, data: input };
  }
}

describe("ToolRouter", () => {
  it("executes the tool when policies allow", async () => {
    const router = new ToolRouter([new EchoTool()], new PolicyEngine([]));
    const result = await router.call("publish_post", "acc-1", { value: "hi" });
    expect(result.success).toBe(true);
  });

  it("denies execution when a policy denies", async () => {
    const router = new ToolRouter(
      [new EchoTool()],
      new PolicyEngine([new ContentApprovalPolicy()]),
    );
    const result = await router.call("publish_post", "acc-1", { contentStatus: "draft" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("content-approval");
  });

  it("returns an error for an unknown tool", async () => {
    const router = new ToolRouter([], new PolicyEngine([]));
    const result = await router.call("doesNotExist", "acc-1", {});
    expect(result.success).toBe(false);
  });
});
