"use client";

import { useCollectAnalytics, usePostAnalytics, type AnalyticsMetricDto } from "@/lib/api";
import { StatusBadge } from "@/components/ui/status-badge";

/**
 * Per-post analytics.
 *
 * Analytics *status* is shown alongside the numbers so the operator can tell
 * "0 shares" from "shares data not yet available" — the distinction §36 of the
 * brief exists to protect.
 */

const DISPLAY_METRICS: { name: string; label: string; kind?: "ratio" }[] = [
  { name: "reach", label: "Reach" },
  { name: "views", label: "Views" },
  { name: "likes", label: "Likes" },
  { name: "comments", label: "Comments" },
  { name: "shares", label: "Shares" },
  { name: "saves", label: "Saves" },
  { name: "follows", label: "Follows" },
  { name: "engagement_rate", label: "Engagement rate", kind: "ratio" },
  { name: "share_rate", label: "Share rate", kind: "ratio" },
  { name: "save_rate", label: "Save rate", kind: "ratio" },
];

function MetricValue({ metric, kind }: { metric?: AnalyticsMetricDto; kind?: "ratio" }) {
  if (!metric || !metric.available || metric.value === undefined) {
    return (
      <span
        className="text-white/30"
        title={metric?.unavailableReason ?? "The platform did not return this metric"}
      >
        Not available
      </span>
    );
  }
  return (
    <span className="text-white" title={metric.computation ? `${metric.computation.formula}` : undefined}>
      {kind === "ratio" ? `${(metric.value * 100).toFixed(2)}%` : metric.value.toLocaleString()}
    </span>
  );
}

export function PostAnalyticsPanel({ contentPostId }: { contentPostId: string }) {
  const analyticsQuery = usePostAnalytics(contentPostId);
  const collect = useCollectAnalytics();

  const analytics = analyticsQuery.data;
  if (analyticsQuery.isLoading) {
    return <p className="text-sm text-white/40">Loading analytics…</p>;
  }
  if (!analytics) return null;

  const byName = Object.fromEntries(analytics.metrics.map((m) => [m.name, m]));
  const hasMetrics = analytics.metrics.length > 0;

  return (
    <div className="space-y-4 rounded-xl border border-surface-border bg-surface-raised p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-xs uppercase tracking-wide text-white/40">Performance</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/40">
            <StatusBadge status={analytics.status} />
            {analytics.platform ? <span>{analytics.platform}</span> : null}
            {analytics.publishedAt ? (
              <span>published {new Date(analytics.publishedAt).toLocaleString()}</span>
            ) : null}
          </div>
        </div>
        <button
          onClick={() => collect.mutate(contentPostId)}
          disabled={collect.isPending}
          className="rounded-md border border-surface-border px-3 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/5 disabled:opacity-50"
        >
          {collect.isPending ? "Collecting…" : "Collect now"}
        </button>
      </div>

      {analytics.status === "pending" && !hasMetrics ? (
        <p className="text-sm text-white/50">
          Analytics collection is scheduled.
          {analytics.nextSnapshotAt
            ? ` Next snapshot ${new Date(analytics.nextSnapshotAt).toLocaleString()}.`
            : ""}
        </p>
      ) : null}

      {analytics.lastError ? <p className="text-sm text-amber-400/80">{analytics.lastError}</p> : null}
      {collect.data?.reason ? <p className="text-sm text-amber-400/80">{collect.data.reason}</p> : null}

      {hasMetrics ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {DISPLAY_METRICS.map((entry) => (
            <div key={entry.name} className="flex items-baseline justify-between gap-2">
              <dt className="text-white/50">{entry.label}</dt>
              <dd>
                <MetricValue metric={byName[entry.name]} kind={entry.kind} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {analytics.history.length > 0 ? (
        <div>
          <p className="mb-1 text-xs uppercase tracking-wide text-white/40">Snapshot history</p>
          <ul className="space-y-1 text-xs text-white/50">
            {analytics.history.map((snapshot) => (
              <li key={snapshot.id} className="flex items-center gap-2">
                <span className="text-white/70">{snapshot.collectionWindow ?? "manual"}</span>
                <span>{new Date(snapshot.capturedAt).toLocaleString()}</span>
                {snapshot.outcome ? <span className="text-white/30">({snapshot.outcome})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {analytics.externalPostId ? (
        <p className="text-[11px] text-white/25">Instagram media id: {analytics.externalPostId}</p>
      ) : null}
    </div>
  );
}
