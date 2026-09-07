import type { Tool } from "../tool.js";

export interface SearchWebInput {
  query: string;
}

export interface SearchWebResult {
  results: { title: string; url: string; snippet: string }[];
}

/** Stub — real implementation will call a search API. */
export class SearchWebTool implements Tool<SearchWebInput, SearchWebResult> {
  readonly name = "searchWeb";
  readonly description = "Search the web for niche/trend/competitor research.";

  async execute(input: SearchWebInput) {
    return {
      success: true,
      data: {
        results: [
          {
            title: `[stub] Result for "${input.query}"`,
            url: "https://example.com",
            snippet: "Mock search result — replace with a real search provider.",
          },
        ],
      },
    };
  }
}
