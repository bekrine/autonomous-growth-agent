import type { Agent, AgentContext, AgentResult } from "../types.js";
import {
  AnalyticsInsightSchema,
  buildAnalyticsPrompt,
  MIN_SAMPLE_FOR_CLAIMS,
  type AnalyticsInsightResult,
  type AnalyticsPromptInput,
} from "../prompts/analytics/index.js";

/**
 * Turns measured analytics into structured, evidence-backed observations.
 *
 * Three boundaries define this agent:
 *
 *  1. It never calls Meta. All numbers arrive pre-computed in its context,
 *     produced by AnalyticsService from stored snapshots.
 *  2. It never modifies strategy. Its output schema has no field that could
 *     express a strategy change; opportunities are suggestions for a human.
 *  3. It never runs per metric. Collection is deterministic arithmetic; this
 *     agent runs only when someone asks for an interpretation, which keeps
 *     LLM cost proportional to analysis rather than to data volume.
 *
 * Confidence is clamped by sample size *after* the model answers, because a
 * model asked not to overclaim will still sometimes overclaim.
 */
export class AnalyticsAgent implements Agent {
  readonly name = "analytics" as const;

  async run(context: AgentContext): Promise<AgentResult> {
    const input = context.analyticsInput as AnalyticsPromptInput | undefined;

    if (!input || input.postCount === 0) {
      return {
        decisions: [
          {
            decision: "insufficient_data",
            reason: "No published content has analytics yet, so there is nothing to interpret.",
          },
        ],
        actions: [],
        data: {
          insights: {
            summary: "No analytics have been collected yet.",
            observations: [],
            opportunities: [],
            risks: [],
            dataQuality: "No posts with analytics data.",
          } satisfies AnalyticsInsightResult,
        },
      };
    }

    const { systemPrompt, prompt } = buildAnalyticsPrompt(input);

    const insights = await context.llm.generateStructured<AnalyticsInsightResult>({
      systemPrompt,
      prompt,
      schema: AnalyticsInsightSchema,
      schemaName: "AnalyticsInsight",
    });

    const guarded = enforceSampleSizeDiscipline(insights, input.postCount);

    return {
      decisions: [
        // One decision per observation, so each lands in agent_decisions as a
        // queryable row with its evidence — not a prose blob.
        ...guarded.observations.map((observation) => ({
          decision: "performance_observation",
          reason: observation.finding,
          metadata: {
            confidence: observation.confidence,
            dimension: observation.dimension,
            dimensionValue: observation.dimensionValue,
            insightType: observation.type,
            evidence: observation.evidence,
            sampleSize: observation.sampleSize,
          },
        })),
        {
          decision: "analytics_summary",
          reason: guarded.summary,
          metadata: { dataQuality: guarded.dataQuality, postCount: input.postCount },
        },
      ],
      actions: [],
      data: { insights: guarded },
    };
  }
}

/**
 * Caps confidence and softens language when the sample is too small to
 * support a general claim. A single post outperforming the median is an early
 * signal, not evidence that a format works.
 */
export function enforceSampleSizeDiscipline(
  insights: AnalyticsInsightResult,
  postCount: number,
): AnalyticsInsightResult {
  if (postCount >= MIN_SAMPLE_FOR_CLAIMS) return insights;

  const cap = 0.45;
  return {
    ...insights,
    observations: insights.observations.map((observation) => ({
      ...observation,
      confidence: Math.min(observation.confidence, cap),
      // Never let a small-sample observation claim a larger sample than exists.
      sampleSize: Math.min(observation.sampleSize, postCount),
      finding: observation.finding.match(/^early signal/i)
        ? observation.finding
        : `Early signal: ${observation.finding}`,
    })),
    dataQuality: `${insights.dataQuality} Based on only ${postCount} post(s) — more observations are needed before drawing conclusions.`,
  };
}
