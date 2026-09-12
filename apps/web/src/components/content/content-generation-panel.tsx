"use client";

import { useMemo, useState } from "react";
import {
  useAccounts,
  useAgentRun,
  useContent,
  useContentVersions,
  useGenerateContent,
  useStartAgentRun,
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
  const runQuery = useAgentRun(activeRunId);
  const contentQuery = useContent(contentPostId);
  const versionsQuery = useContentVersions(contentPostId);

  const accounts = accountsQuery.data ?? [];
  const effectiveAccountId = selectedAccountId || accounts[0]?.id || "";
  const ideas = useMemo(() => runQuery.data?.contentIdeas ?? [], [runQuery.data]);

  async function handleStartRun() {
    if (!effectiveAccountId) return;
    const result = await startRun.mutateAsync(effectiveAccountId);
    setActiveRunId(result.runId);
    setSelectedIdeaId(null);
    setContentPostId(null);
  }

  async function handleGenerate() {
    if (!selectedIdeaId) return;
    const result = await generate.mutateAsync(selectedIdeaId);
    setContentPostId(result.contentId);
  }

  const content = contentQuery.data;
  const generation = content?.generation ?? null;

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
          disabled={!selectedIdeaId || generate.isPending}
          className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {generate.isPending ? "Generating…" : "2. Generate content"}
        </button>

        {startRun.isError ? <p className="text-sm text-rose-400">{(startRun.error as Error).message}</p> : null}
        {generate.isError ? <p className="text-sm text-rose-400">{(generate.error as Error).message}</p> : null}
      </div>

      {generate.isPending ? (
        <p className="text-sm text-white/50">
          Running Content Creator → media generation → Reviewer (regenerates automatically if rejected)…
        </p>
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
