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
  id: string;
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

/* ---------- Phase 3: content generation ---------- */

export interface ContentAssetDto {
  id: string;
  type: string;
  url: string | null;
  provider: string;
  status: string;
}

export interface ContentReviewDto {
  approved: boolean;
  score: number;
  qualityScore: number;
  brandScore: number;
  safetyScore: number;
  issues: { type: string; message: string }[];
  warnings: string[];
  recommendedChanges: string[];
}

export interface ReelSceneDto {
  scene: string;
  voiceover: string;
  onScreenText: string;
}

export interface CarouselSlideDto {
  slideNumber: number;
  headline: string;
  body: string;
  visualDirection: string;
}

export interface ContentGenerationDto {
  generationId: string;
  version: number;
  attempt: number;
  format: string;
  status: string;
  errorMessage: string | null;
  hook?: string;
  title?: string;
  caption?: string;
  callToAction?: string;
  altText?: string;
  visualDirection?: string;
  headline?: string;
  supportingText?: string;
  script?: ReelSceneDto[];
  slides?: CarouselSlideDto[];
  body?: string;
  keywords?: string[];
  contentWarnings?: string[];
  assets: ContentAssetDto[];
  review: ContentReviewDto | null;
  createdAt: string;
}

export interface ContentDto {
  contentId: string;
  status: string;
  generationVersion: number;
  generationAttempts: number;
  generation: ContentGenerationDto | null;
  error?: string;
}

export interface ContentVersionsDto {
  contentPostId: string;
  status: string;
  versions: ContentGenerationDto[];
}

export function useContent(contentPostId: string | null) {
  return useQuery({
    queryKey: ["content", contentPostId],
    queryFn: () => fetchJson<ContentDto>(`/content/${contentPostId}`),
    enabled: Boolean(contentPostId),
  });
}

export function useContentVersions(contentPostId: string | null) {
  return useQuery({
    queryKey: ["content-versions", contentPostId],
    queryFn: () => fetchJson<ContentVersionsDto>(`/content/${contentPostId}/versions`),
    enabled: Boolean(contentPostId),
  });
}

/** Runs ContentCreator -> media -> Reviewer synchronously; `contentIdeaId` is the *idea*, the result is the content post. */
export function useGenerateContent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contentIdeaId: string) =>
      fetchJson<ContentDto>(`/content/${contentIdeaId}/generate`, { method: "POST" }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["content", result.contentId] });
      void queryClient.invalidateQueries({ queryKey: ["content-versions", result.contentId] });
    },
  });
}

/* ---------- Phase 4: social connections & publishing ---------- */

export interface SocialConnectionDto {
  id: string;
  socialAccountId: string;
  platform: string;
  platformAccountId: string;
  platformUsername: string | null;
  accountType: "business" | "creator" | "personal" | "unknown";
  status: "connected" | "expired" | "revoked" | "error";
  tokenExpiresAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface InstagramStatusDto {
  configured: boolean;
  connected: boolean;
  connectionId?: string;
  username?: string | null;
  accountType?: string;
  status?: string;
  healthy?: boolean;
  tokenExpiresAt?: string | null;
}

export interface PublishingJobDto {
  id: string;
  contentPostId: string;
  contentGenerationId: string | null;
  socialConnectionId: string | null;
  platform: string | null;
  status:
    | "queued"
    | "scheduled"
    | "publishing"
    | "published"
    | "retry_scheduled"
    | "failed"
    | "cancelled"
    | "processing"
    | "succeeded";
  attempts: number;
  scheduledFor: string | null;
  externalPostId: string | null;
  externalContainerId: string | null;
  errorCode: string | null;
  lastError: string | null;
  publishedAt: string | null;
  createdAt: string;
}

/** A denial carries a structured reason rather than throwing — the UI shows it inline. */
export interface PublishDenialDto {
  allowed: false;
  reason?: string;
}

export interface PublishAcceptedDto {
  accepted: true;
  publishingJobId: string;
  status: string;
}

export function useInstagramStatus(accountId: string | null) {
  return useQuery({
    queryKey: ["instagram-status", accountId],
    queryFn: () => fetchJson<InstagramStatusDto>(`/social/instagram/status?accountId=${accountId}`),
    enabled: Boolean(accountId),
  });
}

export function useSocialConnections(accountId?: string | null) {
  return useQuery({
    queryKey: ["social-connections", accountId ?? "all"],
    queryFn: () =>
      fetchJson<SocialConnectionDto[]>(`/social/connections${accountId ? `?accountId=${accountId}` : ""}`),
  });
}

/** Returns the Meta consent URL; the caller navigates the browser to it. */
export function useConnectInstagram() {
  return useMutation({
    mutationFn: (accountId: string) =>
      fetchJson<{ authorizationUrl: string }>(`/social/instagram/connect?accountId=${accountId}`),
  });
}

export function useDisconnectConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const response = await fetch(`/api/backend/social/connections/${connectionId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to disconnect the account.");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["social-connections"] });
      void queryClient.invalidateQueries({ queryKey: ["instagram-status"] });
    },
  });
}

export function usePublishingJobs() {
  return useQuery({
    queryKey: ["publishing-jobs"],
    queryFn: () => fetchJson<PublishingJobDto[]>("/publishing-jobs"),
    // Jobs move through states in the worker, so poll while the page is open.
    refetchInterval: 5000,
  });
}

async function postPublish(path: string, body: unknown): Promise<PublishAcceptedDto | PublishDenialDto> {
  const response = await fetch(`/api/backend${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));

  // 409 = policy/state denial. It is an expected outcome, not an error, so it
  // is returned for inline display rather than thrown.
  if (response.status === 409) return { allowed: false, reason: payload.reason } as PublishDenialDto;
  if (!response.ok) throw new Error(payload?.error?.message ?? "Publishing request failed.");
  return payload as PublishAcceptedDto;
}

export function usePublishNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contentPostId: string; socialConnectionId: string }) =>
      postPublish(`/content/${input.contentPostId}/publish`, { socialConnectionId: input.socialConnectionId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["publishing-jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["content"] });
    },
  });
}

export function useSchedulePublish() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contentPostId: string; socialConnectionId: string; scheduledFor: string }) =>
      postPublish(`/content/${input.contentPostId}/schedule`, {
        socialConnectionId: input.socialConnectionId,
        scheduledFor: input.scheduledFor,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["publishing-jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["content"] });
    },
  });
}

export function useCancelPublishingJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (publishingJobId: string) => {
      const response = await fetch(`/api/backend/publishing-jobs/${publishingJobId}/cancel`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 409) throw new Error("Failed to cancel the job.");
      return payload as { cancelled: boolean; reason?: string };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["publishing-jobs"] });
    },
  });
}
