import { z } from "zod";
import { EXPERIMENT_METRICS, EXPERIMENT_VARIABLES } from "../../experiments/experiment-config.js";

/**
 * The ExperimentAgent proposes designs and summarizes results. It decides
 * nothing.
 *
 * The schema constrains it to the supported variables and metrics — it cannot
 * invent a variable the engine does not know how to apply, or a metric the
 * analytics layer never produces. Everything it proposes is then re-checked by
 * ExperimentValidationService, which is the actual authority.
 */

export const ExperimentProposalSchema = z.object({
  name: z.string().describe("Short descriptive name, e.g. 'Hook style: generic vs pain-point'"),
  hypothesis: z
    .string()
    .describe("What you expect to happen and why, grounded in the analytics provided. One or two sentences."),
  variable: z.enum(EXPERIMENT_VARIABLES).describe("The single thing being varied"),
  primaryMetric: z.enum(EXPERIMENT_METRICS).describe("The metric the result should be judged on"),
  secondaryMetrics: z.array(z.enum(EXPERIMENT_METRICS)).describe("Other metrics worth watching. May be empty."),
  control: z.object({
    name: z.string().describe("Name of the control arm"),
    variableValue: z.string().describe("The control's value for the variable, e.g. 'generic'"),
    description: z.string().describe("How content for this arm should be written"),
  }),
  variant: z.object({
    name: z.string().describe("Name of the variant arm"),
    variableValue: z.string().describe("The variant's value for the variable, e.g. 'pain_point'"),
    description: z.string().describe("How content for this arm should be written"),
  }),
  expectedOutcome: z.string().describe("What result would support the hypothesis"),
  rationale: z
    .string()
    .describe("Concise reasoning from the supplied analytics. Cite figures where available; never invent them."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How promising this test looks given the evidence. Low when analytics are sparse."),
});

export type ExperimentProposal = z.infer<typeof ExperimentProposalSchema>;

export const ExperimentSummaryOutputSchema = z.object({
  summary: z.string().describe("What the experiment showed, in plain language, matching the computed outcome"),
  recommendation: z
    .string()
    .describe("What a human might consider testing or doing next. A suggestion only — never an instruction."),
  caveats: z.array(z.string()).describe("Limits on how far this result can be trusted"),
});

export type ExperimentSummaryOutput = z.infer<typeof ExperimentSummaryOutputSchema>;

export interface ExperimentProposalPromptInput {
  niche: string | null;
  targetAudience: string | null;
  postCount: number;
  baseline: Record<string, number>;
  insights: { type: string; dimensionValue: string | null; finding: string; confidence?: number; sampleSize?: number }[];
  recentPosts: { format: string | null; contentPillar: string | null; metrics: Record<string, number | undefined> }[];
  pastExperiments: { name: string; variable: string | null; outcome: string | null; conclusion: string | null }[];
  activeVariables: string[];
  unavailableMetrics: string[];
}

export function buildExperimentProposalPrompt(input: ExperimentProposalPromptInput): {
  systemPrompt: string;
  prompt: string;
} {
  const systemPrompt = [
    "You design controlled experiments for a social-media growth system.",
    "",
    "Rules:",
    "- Vary exactly ONE thing. Everything else about the two arms must be comparable, or the result cannot be attributed to anything.",
    "- Choose a primary metric that the analytics layer actually produces, and prefer a rate over a raw count.",
    "- Ground the hypothesis in the analytics provided. If the data is thin, say so and keep confidence low.",
    "- Never invent a metric value. Metrics listed as unavailable must not be cited or estimated.",
    "- Do not propose a variable that is already under test.",
    "- Do not propose changing the account strategy. You are designing a test, not making a decision.",
    "",
    "Respond with ONLY a JSON object matching this shape, no prose, no markdown fences.",
    'JSON shape: { "name": string, "hypothesis": string, "variable": one of [' +
      EXPERIMENT_VARIABLES.join("|") +
      '], "primaryMetric": one of [' +
      EXPERIMENT_METRICS.join("|") +
      '], "secondaryMetrics": string[], "control": { "name": string, "variableValue": string, "description": string }, "variant": { "name": string, "variableValue": string, "description": string }, "expectedOutcome": string, "rationale": string, "confidence": number 0-1 }',
  ].join("\n");

  const insightLines = input.insights.map(
    (i) => `  - [${i.type}] ${i.dimensionValue ?? ""}: ${i.finding} (confidence ${i.confidence ?? "?"}, n=${i.sampleSize ?? "?"})`,
  );

  const postLines = input.recentPosts.map((p, i) => {
    const metrics = Object.entries(p.metrics)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === "number" ? Number(v.toFixed(4)) : v}`)
      .join(", ");
    return `  ${i + 1}. format=${p.format ?? "?"} pillar=${p.contentPillar ?? "?"} :: ${metrics || "(no metrics available)"}`;
  });

  const pastLines = input.pastExperiments.map(
    (e) => `  - "${e.name}" varied ${e.variable ?? "?"} -> ${e.outcome ?? "no result yet"}${e.conclusion ? `: ${e.conclusion}` : ""}`,
  );

  const prompt = [
    `Account niche: ${input.niche ?? "unspecified"}`,
    `Target audience: ${input.targetAudience ?? "unspecified"}`,
    `Posts with analytics: ${input.postCount}`,
    "",
    "Account baseline (median):",
    Object.entries(input.baseline)
      .map(([k, v]) => `  ${k}: ${Number(v.toFixed(4))}`)
      .join("\n") || "  (no baseline yet)",
    "",
    "Analytics observations:",
    insightLines.join("\n") || "  (none recorded yet)",
    "",
    "Recent measured content:",
    postLines.join("\n") || "  (none)",
    "",
    "Previous experiments (do not repeat a test that already has a clear answer):",
    pastLines.join("\n") || "  (none)",
    "",
    input.activeVariables.length > 0
      ? `Variables already under test — do NOT propose these: ${input.activeVariables.join(", ")}`
      : "No variables are currently under test.",
    input.unavailableMetrics.length > 0
      ? `Metrics the platform does NOT provide (never cite or choose these): ${input.unavailableMetrics.join(", ")}`
      : "",
    "",
    input.postCount < 5
      ? "NOTE: very little performance data exists. Propose a simple, low-risk test and keep confidence below 0.4."
      : "",
    "Propose one controlled experiment.",
  ]
    .filter(Boolean)
    .join("\n");

  return { systemPrompt, prompt };
}

export interface ExperimentSummaryPromptInput {
  name: string;
  hypothesis: string;
  variable: string;
  primaryMetric: string;
  /** The computed verdict. The agent explains this; it does not revisit it. */
  outcome: string;
  confidence: string;
  controlValue?: number;
  variantValue?: number;
  relativeLift?: number;
  sampleSizes: Record<string, number>;
  reasons: string[];
  conclusion: string;
}

export function buildExperimentSummaryPrompt(input: ExperimentSummaryPromptInput): {
  systemPrompt: string;
  prompt: string;
} {
  const systemPrompt = [
    "You explain the result of a completed social-media experiment to a human operator.",
    "",
    "Rules:",
    "- The outcome, confidence and numbers below were computed deterministically. Do not dispute, recompute or embellish them.",
    "- Never say a result is 'proven', 'significant' or 'conclusive'. No statistical test was performed.",
    "- Match your language to the computed outcome: a directional winner is a signal, not a fact.",
    "- The recommendation is a suggestion for a human to consider. You are not changing the strategy.",
    "- State the real limits: sample size, unavailable metrics, imbalance.",
    "",
    "Respond with ONLY a JSON object, no prose, no markdown fences.",
    'JSON shape: { "summary": string, "recommendation": string, "caveats": string[] }',
  ].join("\n");

  const prompt = [
    `Experiment: ${input.name}`,
    `Hypothesis: ${input.hypothesis}`,
    `Variable: ${input.variable}`,
    `Primary metric: ${input.primaryMetric}`,
    "",
    `Computed outcome: ${input.outcome}`,
    `Computed confidence: ${input.confidence}`,
    input.controlValue !== undefined ? `Control median: ${input.controlValue}` : "",
    input.variantValue !== undefined ? `Variant median: ${input.variantValue}` : "",
    input.relativeLift !== undefined ? `Relative difference: ${(input.relativeLift * 100).toFixed(1)}%` : "",
    `Sample sizes: ${Object.entries(input.sampleSizes)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
    "",
    "Why the engine reached this outcome:",
    input.reasons.map((r) => `  - ${r}`).join("\n"),
    "",
    `Engine conclusion: ${input.conclusion}`,
    "",
    "Explain this result.",
  ]
    .filter(Boolean)
    .join("\n");

  return { systemPrompt, prompt };
}
