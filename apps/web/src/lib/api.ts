"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Every call goes through the `/api/backend/*` rewrite in next.config.mjs,
 * which proxies to the Express API's `/api/*` routes — the dashboard never
 * talks to the API's origin directly.
 */
const API_BASE = "/api/backend";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `Request failed with status ${response.status}`);
  }
  return response.json();
}

export interface AccountDto {
  id: string;
  platform: string;
  displayName: string;
  status: string;
}

export interface ResearchTopicDto {
  topic: string;
  relevanceScore: number;
  audienceInterestScore: number;
  competitionScore: number;
  rationale: string | null;
  sourceType: string;
}

export interface StrategySnapshotDto {
  versionNumber: number;
  summary: string;
  data: {
    audience?: string;
    positioning?: string;
    contentPillars?: { name: string; weight: number }[];
    formats?: Record<string, number>;
    postingFrequencyPerWeek?: number;
  };
  createdAt: string;
}

export interface ContentIdeaDto {
  title: string;
  format: string | null;
  contentPillar: string | null;
  targetAudience: string | null;
  hook: string | null;
  objective: string | null;
  priorityScore: number | null;
}

export interface AgentDecisionDto {
  id: string;
  agentName: string;
  decision: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentActionDto {
  id: string;
  actionType: string;
  status: string;
  createdAt: string;
}

export interface AgentRunResultDto {
  runId: string;
  status: "completed" | "failed" | "running" | "pending";
  research: ResearchTopicDto[];
  strategy: StrategySnapshotDto | null;
  contentIdeas: ContentIdeaDto[];
  error?: string;
}

export interface AgentRunDetailDto extends AgentRunResultDto {
  decisions: AgentDecisionDto[];
  actions: AgentActionDto[];
}

export function useAccounts() {
  return useQuery({ queryKey: ["accounts"], queryFn: () => fetchJson<AccountDto[]>("/accounts") });
}

export function useAgentRun(runId: string | null) {
  return useQuery({
    queryKey: ["agent-run", runId],
    queryFn: () => fetchJson<AgentRunDetailDto>(`/agent/runs/${runId}`),
    enabled: Boolean(runId),
  });
}

export function useStartAgentRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      fetchJson<AgentRunResultDto>("/agent/runs", {
        method: "POST",
        body: JSON.stringify({ accountId }),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["agent-run", result.runId] });
    },
  });
}
