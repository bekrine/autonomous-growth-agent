import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@agent/shared";
import { AnalyticsAgent, enforceSampleSizeDiscipline } from "../agents/analytics-agent.js";
import { AnalyticsInsightSchema, MIN_SAMPLE_FOR_CLAIMS, buildAnalyticsPrompt } from "../prompts/analytics/index.js";
import type { AgentContext } from "../types.js";
import type { AnalyticsAgentInput } from "../context/types.js";

function buildInput(overrides: Partial<AnalyticsAgentInput> = {}): AnalyticsAgentInput {
  return {
    niche: "AI development",
    targetAudience: "developers",
    postCount: 8,
    baselineSampleSize: 8,
    baseline: { reach: 1000, engagement_rate: 0.05 },
    posts: Array.from({ length: 8 }, (_, i) => ({
      format: i % 2 === 0 ? "reel" : "carousel",
      contentPillar: "education",
      title: `Post ${i + 1}`,
      publishedAt: `2026-09-0${i + 1}T10:00:00.000Z`,
      postingHourUtc: 10,
      postingDayUtc: "Tuesday",
      generationVersion: 1,
      metrics: { reach: i % 2 === 0 ? 2100 : 900, engagement_rate: 0.06 },
      performanceScore: i % 2 === 0 ? 2.1 : 0.9,
    })),
    followerChange: 37,
    unavailableMetrics: ["shares"],
    ...overrides,
  };
}

function buildContext(input: AnalyticsAgentInput | undefined, response: unknown): AgentContext {
  const generateStructured = vi.fn(async () => response);
  return {
    account: { id: "a", platform: "instagram", displayName: "Test", niche: "AI", targetAudience: null, tone: null },
    goal: null,
    currentStrategy: null,
    recentContent: [],
    recentAnalytics: [],
    previousStrategyVersions: [],
    activeExperiments: [],
    research: [],
    policies: { autonomyEnabled: false, contentApprovalRequired: true },
    agentProfileId: "profile-1",
    analyticsInput: input,
    runId: "run-1",
    accountId: "a",
    logger: createLogger({ name: "test", level: "silent" }),
    llm: { name: "mock", generateText: vi.fn(), generateStructured } as unknown as AgentContext["llm"],
    tools: {} as AgentContext["tools"],
    previousResults: {},
    targetContentIdea: null,
    regenerationFeedback: [],
  } as AgentContext;
}

const HEALTHY_RESPONSE = {
  summary: "Reels are reaching more people than carousels.",
  observations: [
    {
      type: "format" as const,
      dimension: "format",
      dimensionValue: "reel",
      finding: "Reels averaged 2.1x the account median reach",
      evidence: "4 reels averaged 2100 reach vs a 1000 median over 8 posts",
      confidence: 0.86,
      sampleSize: 8,
    },
  ],
  opportunities: ["Test more short-form video"],
  risks: [],
  dataQuality: "8 posts with reach available; shares unavailable.",
};

describe("AnalyticsAgent", () => {
  it("produces structured insights with evidence, confidence and sample size", async () => {
    const agent = new AnalyticsAgent();
    const result = await agent.run(buildContext(buildInput(), HEALTHY_RESPONSE));

    const insights = (result.data as { insights: typeof HEALTHY_RESPONSE }).insights;
    expect(insights.observations[0]).toMatchObject({
      type: "format",
      dimensionValue: "reel",
      confidence: 0.86,
      sampleSize: 8,
    });
    expect(insights.observations[0]!.evidence).toContain("2100");
  });

  it("records each observation as its own queryable decision with concise reasoning", async () => {
    const agent = new AnalyticsAgent();
    const result = await agent.run(buildContext(buildInput(), HEALTHY_RESPONSE));

    const observation = result.decisions.find((d) => d.decision === "performance_observation")!;
    expect(observation.reason).toContain("2.1x");
    expect(observation.metadata).toMatchObject({ dimension: "format", dimensionValue: "reel", sampleSize: 8 });
    expect(result.decisions.some((d) => d.decision === "analytics_summary")).toBe(true);
  });

  it("never emits an action — it cannot change anything", async () => {
    const agent = new AnalyticsAgent();
    const result = await agent.run(buildContext(buildInput(), HEALTHY_RESPONSE));

    // Actions are how agents cause effects. Analytics has none, by design.
    expect(result.actions).toEqual([]);
  });

  it("reports insufficient data instead of calling the LLM when nothing is measured", async () => {
    const agent = new AnalyticsAgent();
    const context = buildContext(buildInput({ postCount: 0, posts: [] }), HEALTHY_RESPONSE);

    const result = await agent.run(context);

    expect(result.decisions[0]!.decision).toBe("insufficient_data");
    // No LLM spend when there is nothing to interpret.
    expect(context.llm.generateStructured).not.toHaveBeenCalled();
  });

  it("handles a missing analytics input without throwing", async () => {
    const result = await new AnalyticsAgent().run(buildContext(undefined, HEALTHY_RESPONSE));
    expect(result.decisions[0]!.decision).toBe("insufficient_data");
  });
});

describe("sample-size discipline", () => {
  it("caps confidence and hedges the wording on a tiny sample", () => {
    const guarded = enforceSampleSizeDiscipline(
      {
        ...HEALTHY_RESPONSE,
        observations: [
          {
            ...HEALTHY_RESPONSE.observations[0]!,
            finding: "Reels are definitely better than carousels",
            confidence: 0.95,
            sampleSize: 8,
          },
        ],
      },
      1,
    );

    const observation = guarded.observations[0]!;
    expect(observation.confidence).toBeLessThanOrEqual(0.45);
    expect(observation.finding.toLowerCase()).toContain("early signal");
    // Cannot claim a larger sample than actually exists.
    expect(observation.sampleSize).toBe(1);
    expect(guarded.dataQuality).toContain("only 1 post");
  });

  it("leaves an adequately-sampled observation untouched", () => {
    const guarded = enforceSampleSizeDiscipline(HEALTHY_RESPONSE, MIN_SAMPLE_FOR_CLAIMS);
    expect(guarded.observations[0]!.confidence).toBe(0.86);
    expect(guarded.observations[0]!.finding).not.toMatch(/early signal/i);
  });

  it("applies the cap end-to-end through the agent", async () => {
    const overconfident = {
      ...HEALTHY_RESPONSE,
      observations: [{ ...HEALTHY_RESPONSE.observations[0]!, confidence: 0.99, sampleSize: 50 }],
    };
    const result = await new AnalyticsAgent().run(
      buildContext(buildInput({ postCount: 2, posts: buildInput().posts.slice(0, 2) }), overconfident),
    );

    const insights = (result.data as { insights: typeof HEALTHY_RESPONSE }).insights;
    expect(insights.observations[0]!.confidence).toBeLessThanOrEqual(0.45);
    expect(insights.observations[0]!.sampleSize).toBe(2);
  });
});

describe("analytics prompt", () => {
  it("forbids overclaiming and names unavailable metrics so they are not estimated", () => {
    const { systemPrompt, prompt } = buildAnalyticsPrompt(buildInput({ postCount: 2 }));

    expect(systemPrompt).toContain("You do NOT set strategy");
    expect(systemPrompt).toContain("Never invent a metric");
    expect(prompt).toContain("shares");
    expect(prompt).toContain("only 2 post(s)");
  });

  it("includes the dimensions later phases will group by", () => {
    const { prompt } = buildAnalyticsPrompt(buildInput());
    expect(prompt).toContain("format=reel");
    expect(prompt).toContain("pillar=education");
    expect(prompt).toContain("UTC hour 10");
    expect(prompt).toContain("generation version");
  });
});

describe("insight schema", () => {
  it("has no field capable of expressing a strategy mutation", () => {
    const keys = Object.keys(AnalyticsInsightSchema.shape);

    expect(keys.sort()).toEqual(["dataQuality", "observations", "opportunities", "risks", "summary"]);
    // Nothing that could be interpreted as an instruction to change strategy.
    for (const forbidden of ["strategy", "contentPillars", "postingFrequency", "targetAudience", "actions"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("rejects an observation without evidence or confidence", () => {
    const invalid = {
      summary: "x",
      observations: [{ type: "format", dimension: "format", dimensionValue: "reel", finding: "good" }],
      opportunities: [],
      risks: [],
      dataQuality: "x",
    };
    expect(AnalyticsInsightSchema.safeParse(invalid).success).toBe(false);
  });
});
