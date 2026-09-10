import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../policy-engine.js";
import { KillSwitchStore } from "../kill-switch.js";
import { KillSwitchPolicy } from "../policies/kill-switch-policy.js";
import { ContentApprovalPolicy } from "../policies/content-approval-policy.js";
import { HumanApprovalPolicy } from "../policies/human-approval-policy.js";
import { DailyGenerationLimitPolicy } from "../policies/daily-generation-limit-policy.js";

describe("PolicyEngine", () => {
  it("allows when every policy allows", async () => {
    const engine = new PolicyEngine([new ContentApprovalPolicy(), new HumanApprovalPolicy()]);
    const result = await engine.evaluate({
      accountId: "acc-1",
      actionType: "publish_post",
      payload: { contentStatus: "approved" },
    });
    expect(result.allowed).toBe(true);
  });

  it("denies publish when content is not approved", async () => {
    const engine = new PolicyEngine([new ContentApprovalPolicy()]);
    const result = await engine.evaluate({
      accountId: "acc-1",
      actionType: "publish_post",
      payload: { contentStatus: "draft" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("content-approval");
  });

  it("denies everything when the global kill switch is on", async () => {
    const killSwitch = new KillSwitchStore(true);
    const engine = new PolicyEngine([new KillSwitchPolicy(killSwitch)]);
    const result = await engine.evaluate({ accountId: "acc-1", actionType: "anything", payload: {} });
    expect(result.allowed).toBe(false);
  });

  it("denies per-account when only that account is disabled", async () => {
    const killSwitch = new KillSwitchStore(false);
    killSwitch.setAccountDisabled("acc-1", true);
    const engine = new PolicyEngine([new KillSwitchPolicy(killSwitch)]);
    const denied = await engine.evaluate({ accountId: "acc-1", actionType: "x", payload: {} });
    const allowed = await engine.evaluate({ accountId: "acc-2", actionType: "x", payload: {} });
    expect(denied.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
  });

  it("requires human approval for sensitive actions", async () => {
    const engine = new PolicyEngine([new HumanApprovalPolicy()]);
    const denied = await engine.evaluate({
      accountId: "acc-1",
      actionType: "update_strategy",
      payload: {},
    });
    const allowed = await engine.evaluate({
      accountId: "acc-1",
      actionType: "update_strategy",
      payload: { humanApproved: true },
    });
    expect(denied.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
  });

  it("caps daily media generation independently of other action types", async () => {
    const policy = new DailyGenerationLimitPolicy(2);
    const engine = new PolicyEngine([policy]);
    const call = () => engine.evaluate({ accountId: "acc-1", actionType: "generateImage", payload: {} });

    expect((await call()).allowed).toBe(true);
    expect((await call()).allowed).toBe(true);
    const third = await call();
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain("daily-generation-limit");

    // Unrelated action types are never limited by this policy.
    const other = await engine.evaluate({ accountId: "acc-1", actionType: "publish_post", payload: {} });
    expect(other.allowed).toBe(true);
  });
});
