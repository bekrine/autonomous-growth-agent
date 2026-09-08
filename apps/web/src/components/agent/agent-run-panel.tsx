"use client";

import { useMemo, useState } from "react";
import { useAccounts, useAgentRun, useStartAgentRun } from "@/lib/api";
import type { AgentActivityItem } from "@/lib/mock-data";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { ActivityTimeline } from "@/components/agent/activity-timeline";

export function AgentRunPanel() {
  const accountsQuery = useAccounts();
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const startRun = useStartAgentRun();
  const runQuery = useAgentRun(activeRunId);

  const accounts = accountsQuery.data ?? [];
  const effectiveAccountId = selectedAccountId || accounts[0]?.id || "";

  async function handleStartRun() {
    if (!effectiveAccountId) return;
    const result = await startRun.mutateAsync(effectiveAccountId);
    setActiveRunId(result.runId);
  }

  const timelineItems = useMemo<AgentActivityItem[]>(() => {
    if (!runQuery.data) return [];
    return runQuery.data.decisions.map((d) => ({
      id: d.id,
      runId: runQuery.data.runId,
      agentName: d.agentName,
      decision: d.decision,
      reason: d.reason ?? "",
      status: "completed" as const,
      timestamp: d.createdAt,
    }));
  }, [runQuery.data]);

  const run = runQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-surface-border bg-surface-raised p-5">
        <select
          value={effectiveAccountId}
          onChange={(e) => setSelectedAccountId(e.target.value)}
          className="rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-white"
        >
          {accounts.length === 0 ? <option value="">No accounts yet</option> : null}
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.displayName} ({account.platform})
            </option>
          ))}
        </select>
        <button
          onClick={() => void handleStartRun()}
          disabled={!effectiveAccountId || startRun.isPending}
          className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {startRun.isPending ? "Running…" : "Start Agent Run"}
        </button>
        {accounts.length === 0 && !accountsQuery.isLoading ? (
          <p className="text-sm text-white/40">
            No accounts found — seed one with <code className="text-white/60">npm run db:seed</code> or create one
            via <code className="text-white/60">POST /api/accounts</code>.
          </p>
        ) : null}
        {startRun.isError ? (
          <p className="text-sm text-rose-400">{(startRun.error as Error).message}</p>
        ) : null}
      </div>

      {run ? (
        <>
          <div className="flex items-center gap-3">
            <p className="text-sm text-white/60">
              Run <span className="font-mono text-white">{run.runId}</span>
            </p>
            <StatusBadge status={run.status} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              stat={{ label: "Research topics", value: String(run.research.length), delta: "", trend: "flat" }}
            />
            <StatCard
              stat={{
                label: "Strategy version",
                value: run.strategy ? `v${run.strategy.versionNumber}` : "—",
                delta: "",
                trend: "flat",
              }}
            />
            <StatCard
              stat={{ label: "Content ideas", value: String(run.contentIdeas.length), delta: "", trend: "flat" }}
            />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
              <h3 className="mb-3 text-sm font-medium text-white/70">Research topics</h3>
              <ul className="space-y-3">
                {run.research.map((topic, index) => (
                  <li key={index} className="text-sm">
                    <p className="text-white">{topic.topic}</p>
                    <p className="text-xs text-white/40">
                      relevance {topic.relevanceScore.toFixed(2)} · interest {topic.audienceInterestScore.toFixed(2)} ·
                      competition {topic.competitionScore.toFixed(2)}
                      {topic.sourceType === "mock" ? " · simulated source" : ""}
                    </p>
                  </li>
                ))}
                {run.research.length === 0 ? <p className="text-sm text-white/40">No topics yet.</p> : null}
              </ul>
            </div>

            <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
              <h3 className="mb-3 text-sm font-medium text-white/70">Strategy</h3>
              {run.strategy ? (
                <div className="space-y-2 text-sm">
                  <p className="text-white">{run.strategy.summary}</p>
                  <p className="text-white/60">Positioning: {run.strategy.data.positioning ?? "—"}</p>
                  <p className="text-white/60">
                    Pillars: {(run.strategy.data.contentPillars ?? []).map((p) => p.name).join(", ") || "—"}
                  </p>
                  <p className="text-white/60">
                    Posting frequency: {run.strategy.data.postingFrequencyPerWeek ?? "—"} / week
                  </p>
                </div>
              ) : (
                <p className="text-sm text-white/40">No strategy yet.</p>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
            <h3 className="mb-3 text-sm font-medium text-white/70">Content ideas</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {run.contentIdeas.map((idea, index) => (
                <div key={index} className="rounded-lg border border-surface-border p-4">
                  <p className="text-sm font-medium text-white">{idea.title}</p>
                  <p className="mt-1 text-xs text-white/40 capitalize">
                    {idea.format ?? "—"} · {idea.contentPillar ?? "—"}
                  </p>
                  <p className="mt-2 text-xs text-white/60">{idea.hook}</p>
                </div>
              ))}
              {run.contentIdeas.length === 0 ? <p className="text-sm text-white/40">No ideas yet.</p> : null}
            </div>
          </div>

          <div>
            <h3 className="mb-3 text-sm font-medium text-white/70">Decisions</h3>
            <div className="rounded-xl border border-surface-border bg-surface-raised p-6">
              <ActivityTimeline items={timelineItems} />
              {timelineItems.length === 0 ? <p className="text-sm text-white/40">No decisions recorded yet.</p> : null}
            </div>
          </div>
        </>
      ) : (
        <p className="text-sm text-white/40">Start a run to see research, strategy and content ideas here.</p>
      )}
    </div>
  );
}
