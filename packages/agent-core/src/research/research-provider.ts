/**
 * Raw research signal ResearchAgent reasons over — one candidate topic
 * with lightweight scoring, before the LLM turns it into a scored,
 * rationale-backed `topics` entry. `sourceType` is always propagated
 * through to the persisted research_findings row so simulated research
 * is never mistaken for real external data.
 */
export interface ResearchSignal {
  topic: string;
  signalStrength: number;
  sourceType: string;
  note?: string;
}

export interface ResearchQuery {
  niche: string;
  targetAudience: string | null;
  /** Topics already surfaced in recent runs — providers should avoid resurfacing them verbatim. */
  excludeTopics: string[];
}

/**
 * External research is intentionally not implemented in this phase — this
 * interface is what lets a real WebResearchProvider/TrendProvider/
 * SocialResearchProvider be swapped in later without ResearchAgent (or
 * anything that depends on it) changing at all.
 */
export interface ResearchProvider {
  readonly name: string;
  discoverTopics(query: ResearchQuery): Promise<ResearchSignal[]>;
}

const MOCK_TOPIC_POOL = [
  "beginner-friendly explainer",
  "common mistake breakdown",
  "behind-the-scenes process",
  "tool/workflow comparison",
  "quick-win tip roundup",
  "case study walkthrough",
  "myth vs. reality",
  "before/after transformation",
] as const;

/**
 * Deterministic, clearly-simulated research source used until a real
 * search/trend integration exists. Every signal it returns has
 * `sourceType: "mock"` so downstream code (and prompts fed to the LLM)
 * never present it as genuine external research.
 */
export class MockResearchProvider implements ResearchProvider {
  readonly name = "mock";

  async discoverTopics(query: ResearchQuery): Promise<ResearchSignal[]> {
    const excluded = new Set(query.excludeTopics.map((t) => t.toLowerCase()));
    return MOCK_TOPIC_POOL.filter((pattern) => {
      const candidate = `${query.niche}: ${pattern}`;
      return !excluded.has(candidate.toLowerCase());
    })
      .slice(0, 5)
      .map((pattern, index) => ({
        topic: `${query.niche}: ${pattern}`,
        signalStrength: Math.max(0.4, 0.9 - index * 0.1),
        sourceType: "mock",
        note: "Simulated research signal — no real external source was queried.",
      }));
  }
}
