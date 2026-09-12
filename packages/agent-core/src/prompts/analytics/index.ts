import { z } from "zod";

/**
 * The AnalyticsAgent explains measurements — it does not decide anything.
 *
 * The schema deliberately has no field capable of expressing a strategy
 * change: there is nowhere to put "switch to reels" as an instruction. The
 * closest it can get is a `recommendations` entry, which is explicitly an
 * observation for a human, not an action. Phase 5 measures; Phase 7 adapts.
 */

export const INSIGHT_TYPES = [
  "format",
  "topic",
  "content_pillar",
  "hook",
  "cta",
  "posting_time",
  "audience_response",
  "growth",
  "anomaly",
] as const;

export const AnalyticsInsightSchema = z.object({
  summary: z
    .string()
    .describe("One or two sentences describing what the data shows. Hedge when the sample is small."),
  observations: z
    .array(
      z.object({
        type: z.enum(INSIGHT_TYPES),
        dimension: z.string().describe("The dimension examined, e.g. 'format'"),
        dimensionValue: z.string().describe("The specific value, e.g. 'reel'"),
        finding: z.string().describe("What the numbers show, stated with its evidence"),
        evidence: z.string().describe("The concrete figures supporting this, e.g. '2.1x median reach over 8 posts'"),
        confidence: z.number().min(0).max(1).describe("Lower when the sample is small or the effect is weak"),
        sampleSize: z.number().int().min(0).describe("How many posts this observation is based on"),
      }),
    )
    .describe("Evidence-backed observations. Empty when there is not enough data to say anything."),
  opportunities: z.array(z.string()).describe("Things worth testing later. Suggestions only — never applied."),
  risks: z.array(z.string()).describe("Concerning patterns worth watching"),
  dataQuality: z
    .string()
    .describe("Honest statement of what limits these conclusions, e.g. sample size or unavailable metrics"),
});

export type AnalyticsInsightResult = z.infer<typeof AnalyticsInsightSchema>;

export interface AnalyticsPromptInput {
  niche: string | null;
  targetAudience: string | null;
  postCount: number;
  baselineSampleSize: number;
  baseline: Record<string, number>;
  posts: {
    format: string | null;
    contentPillar: string | null;
    title: string | null;
    publishedAt: string | null;
    postingHourUtc: number | null;
    postingDayUtc: string | null;
    generationVersion: number | null;
    metrics: Record<string, number | undefined>;
    performanceScore?: number;
  }[];
  followerChange?: number;
  unavailableMetrics: string[];
}

/**
 * Minimum posts before the agent is allowed to generalize. Below this it may
 * only report early signals — one post cannot establish that a format works.
 */
export const MIN_SAMPLE_FOR_CLAIMS = 5;

export function buildAnalyticsPrompt(input: AnalyticsPromptInput): { systemPrompt: string; prompt: string } {
  const systemPrompt = [
    "You are an analytics specialist for a social-media growth system.",
    "Your job is to explain what the measured data shows. You do NOT set strategy.",
    "",
    "Rules you must follow:",
    `- With fewer than ${MIN_SAMPLE_FOR_CLAIMS} posts, describe findings as early signals and keep confidence below 0.5. Never state that one format or topic is definitively better.`,
    "- Every observation must cite concrete numbers from the data provided.",
    "- Never invent a metric. If a metric is listed as unavailable, say so instead of estimating it.",
    "- Never recommend changing the strategy as if it were a decision. Opportunities are suggestions for humans to consider.",
    "- Prefer comparisons against the account baseline over absolute numbers.",
    "- If the data does not support any observation, return an empty observations array and say so.",
    "",
    // Same convention as the reviewer prompt: smaller models follow an explicit
    // shape far more reliably than a schema description alone. Without this the
    // model returned a bare array of observations and failed validation.
    "Respond with ONLY a JSON object matching this shape, no prose, no markdown fences.",
    'JSON shape: { "summary": string, "observations": [ { "type": "format"|"topic"|"content_pillar"|"hook"|"cta"|"posting_time"|"audience_response"|"growth"|"anomaly", "dimension": string, "dimensionValue": string, "finding": string, "evidence": string, "confidence": number 0-1, "sampleSize": integer } ], "opportunities": string[], "risks": string[], "dataQuality": string }',
  ].join("\n");

  const postLines = input.posts.map((post, index) => {
    const metrics = Object.entries(post.metrics)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${name}=${typeof value === "number" ? Number(value.toFixed(4)) : value}`)
      .join(", ");
    return [
      `${index + 1}. format=${post.format ?? "unknown"} pillar=${post.contentPillar ?? "unknown"}`,
      `   title: ${post.title ?? "(untitled)"}`,
      `   published: ${post.publishedAt ?? "unknown"} (UTC hour ${post.postingHourUtc ?? "?"}, ${post.postingDayUtc ?? "?"})`,
      `   generation version: ${post.generationVersion ?? "?"}`,
      `   metrics: ${metrics || "(none available)"}`,
      post.performanceScore !== undefined ? `   performance score vs baseline: ${post.performanceScore.toFixed(2)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const baselineLines = Object.entries(input.baseline)
    .map(([name, value]) => `  ${name}: ${Number(value.toFixed(4))}`)
    .join("\n");

  const prompt = [
    `Account niche: ${input.niche ?? "unspecified"}`,
    `Target audience: ${input.targetAudience ?? "unspecified"}`,
    "",
    `Posts with analytics: ${input.postCount}`,
    `Baseline computed from ${input.baselineSampleSize} post(s) (median):`,
    baselineLines || "  (no baseline available yet)",
    input.followerChange !== undefined ? `\nFollower change over the observed period: ${input.followerChange}` : "",
    input.unavailableMetrics.length > 0
      ? `\nMetrics the platform did NOT provide (do not estimate these): ${input.unavailableMetrics.join(", ")}`
      : "",
    "",
    "Published content and measured performance:",
    postLines.join("\n\n") || "(no posts with analytics yet)",
    "",
    input.postCount < MIN_SAMPLE_FOR_CLAIMS
      ? `NOTE: only ${input.postCount} post(s) have analytics. Report early signals only, with confidence below 0.5, and state clearly that more observations are needed.`
      : "",
    "Produce structured insights describing what this data shows.",
  ]
    .filter(Boolean)
    .join("\n");

  return { systemPrompt, prompt };
}
