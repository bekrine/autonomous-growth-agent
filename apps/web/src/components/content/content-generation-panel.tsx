"use client";

import { useMemo, useState } from "react";
import {
  useAccounts,
  useAgentRun,
  useContent,
  useContentByIdea,
  useContentVersions,
  useGenerateContent,
  useQueueContentGeneration,
  useStartAgentRun,
  TERMINAL_CONTENT_STATUSES,
} from "@/lib/api";
import { StatusBadge } from "@/components/ui/status-badge";
import { GeneratedContentDetail } from "./generated-content-detail";
import { PublishActions } from "./publish-actions";
import { PostAnalyticsPanel } from "@/components/analytics/post-analytics-panel";

/**
 * Content ideas come from a Phase 2 agent run, so this panel lets you
 * produce them (Start Agent Run) and then generate content for one
 * (Generate). Both call the real API — no mock data.
 */
export function ContentGenerationPanel() {
  const accountsQuery = useAccounts();
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selectedIdeaId, setSelectedIdeaId] = useState<string | null>(null);
  const [contentPostId, setContentPostId] = useState<string | null>(null);

  const startRun = useStartAgentRun();
  const generate = useGenerateContent();
  const queueGenerate = useQueueContentGeneration();
  /** Set only while a queued (reel) job is in flight, so polling stays scoped. */
  const [queuedIdeaId, setQueuedIdeaId] = useState<string | null>(null);
  const runQuery = useAgentRun(activeRunId);
  const contentQuery = useContent(contentPostId);
  const versionsQuery = useContentVersions(contentPostId);

  const accounts = accountsQuery.data ?? [];
  const effectiveAccountId = selectedAccountId || accounts[0]?.id || "";
  const ideas = useMemo(() => runQuery.data?.contentIdeas ?? [], [runQuery.data]);

  const selectedIdea = ideas.find((idea) => idea.id === selectedIdeaId) ?? null;
  // Reels render a real video, which takes minutes — far too long to hold an
  // HTTP request open, so they go through the queue and we poll instead.
  const isReel = (selectedIdea?.format ?? "").toLowerCase().includes("reel") ||
    (selectedIdea?.format ?? "").toLowerCase().includes("video");

  const queuedContent = useContentByIdea(queuedIdeaId, Boolean(queuedIdeaId));
  const queuedResult = queuedContent.data ?? null;
  const queuedFinished = Boolean(queuedResult && TERMINAL_CONTENT_STATUSES.includes(queuedResult.status));

  async function handleStartRun() {
    if (!effectiveAccountId) return;
    const result = await startRun.mutateAsync(effectiveAccountId);
    setActiveRunId(result.runId);
    setSelectedIdeaId(null);
    setContentPostId(null);
  }

  async function handleGenerate() {
    if (!selectedIdeaId) return;

    if (isReel) {
      setContentPostId(null);
      setQueuedIdeaId(selectedIdeaId);
      await queueGenerate.mutateAsync(selectedIdeaId);
      return;
    }

    const result = await generate.mutateAsync(selectedIdeaId);
    setContentPostId(result.contentId);
  }

  // A finished queued job takes over as the displayed content.
  const content = contentQuery.data ?? (queuedFinished ? queuedResult : null);
  const generation = content?.generation ?? null;
  const busy = generate.isPending || queueGenerate.isPending || (Boolean(queuedIdeaId) && !queuedFinished);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-surface-border bg-surface-raised p-5">
        <select
          value={effectiveAccountId}
          onChange={(e) => setSelectedAccountId(e.target.value)}
          className="rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-white"
        >
          {accounts.length === 0 ? <option value="">No accounts yet</option> : null}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName} ({a.platform})
            </option>
          ))}
        </select>
        <button
          onClick={() => void handleStartRun()}
          disabled={!effectiveAccountId || startRun.isPending}
          className="rounded-md border border-surface-border px-4 py-2 text-sm text-white/80 transition-colors hover:bg-white/5 disabled:opacity-50"
        >
          {startRun.isPending ? "Planning…" : "1. Plan content ideas"}
        </button>

        <select
          value={selectedIdeaId ?? ""}
          onChange={(e) => setSelectedIdeaId(e.target.value || null)}
          disabled={ideas.length === 0}
          className="min-w-[18rem] rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          <option value="">{ideas.length === 0 ? "Run planning first" : "Select a content idea…"}</option>
          {ideas.map((idea) => (
            <option key={idea.id} value={idea.id}>
              [{idea.format ?? "?"}] {idea.title}
            </option>
          ))}
        </select>
        <button
          onClick={() => void handleGenerate()}
          disabled={!selectedIdeaId || busy}
          className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (isReel ? "Rendering…" : "Generating…") : isReel ? "2. Generate reel (queued)" : "2. Generate content"}
        </button>

        {startRun.isError ? <p className="text-sm text-rose-400">{(startRun.error as Error).message}</p> : null}
        {generate.isError ? <p className="text-sm text-rose-400">{(generate.error as Error).message}</p> : null}
        {queueGenerate.isError ? (
          <p className="text-sm text-rose-400">{(queueGenerate.error as Error).message}</p>
        ) : null}
      </div>

      {generate.isPending ? (
        <p className="text-sm text-white/50">
          Running Content Creator → media generation → Reviewer (regenerates automatically if rejected)…
        </p>
      ) : null}

      {queuedIdeaId && !queuedFinished ? (
        <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
          <p className="text-sm text-white/70">
            Queued on the content worker — rendering a real video.
          </p>
          <p className="mt-1 text-xs text-white/40">
            {queuedResult
              ? `Status: ${queuedResult.status.replace(/_/g, " ")}`
              : "Waiting for the worker to pick up the job…"}
            {" · "}
            Video generation typically takes 3–5 minutes. You can leave this page open.
          </p>
        </div>
      ) : null}

      {queuedContent.isError ? (
        <p className="text-sm text-rose-400">{(queuedContent.error as Error).message}</p>
      ) : null}

      {content ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-white/60">
              Content <span className="font-mono text-white">{content.contentId}</span>
            </p>
            <StatusBadge status={content.status} />
            <span className="text-sm text-white/40">
              version {content.generationVersion} · {content.generationAttempts} attempt(s)
            </span>
          </div>

          {content.error ? <p className="text-sm text-rose-400">{content.error}</p> : null}

          <PublishActions
            contentPostId={content.contentId}
            contentStatus={content.status}
            accountId={effectiveAccountId || null}
          />

          {/* Only meaningful once the post is live and being measured. */}
          {content.status === "published" ? <PostAnalyticsPanel contentPostId={content.contentId} /> : null}

          {generation ? (
            <GeneratedContentDetail generation={generation} versions={versionsQuery.data?.versions ?? []} />
          ) : (
            <p className="text-sm text-white/40">No generation recorded for this content yet.</p>
          )}
        </>
      ) : (
        <p className="text-sm text-white/40">
          Plan content ideas, pick one, then generate — the result appears here with its media and review.
        </p>
      )}
    </div>
  );
}
