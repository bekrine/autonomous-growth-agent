"use client";

import { useState } from "react";
import {
  useAccounts,
  useAnalyticsGrowth,
  useAnalyticsOverview,
  useAnalyticsPosts,
  useRunAnalyticsAgent,
  type AnalyticsMetricDto,
  type AnalyticsPostDto,
} from "@/lib/api";
import { StatusBadge } from "@/components/ui/status-badge";
import { FollowerGrowthChart } from "./follower-growth-chart";

/**
 * Real analytics only. Where the platform did not return a metric the UI says
 * "Not available" — it never renders 0, because "nobody shared this" and
 * "Instagram didn't tell us about shares" are different facts and conflating
 * them would quietly mislead.
 */

const SORT_OPTIONS = [
  { value: "performance_score", label: "Performance score" },
  { value: "reach", label: "Reach" },
  { value: "views", label: "Views" },
  { value: "engagement_rate", label: "Engagement rate" },
  { value: "shares", label: "Shares" },
  { value: "saves", label: "Saves" },
  { value: "follows", label: "Follows" },
];

function formatMetric(metric: AnalyticsMetricDto | undefined, kind: "count" | "ratio" = "count") {
  if (!metric || !metric.available || metric.value === undefined) return null;
  return kind === "ratio" ? `${(metric.value * 100).toFixed(2)}%` : metric.value.toLocaleString();
}

function MetricCell({ metric, kind }: { metric?: AnalyticsMetricDto; kind?: "count" | "ratio" }) {
  const formatted = formatMetric(metric, kind);
  if (formatted !== null) return <span className="text-white">{formatted}</span>;
  return (
    <span className="text-white/30" title={metric?.unavailableReason ?? "The platform did not return this metric"}>
      Not available
    </span>
  );
}

function Stat({
  label,
  value,
  hint,
  source,
}: {
  label: string;
  value: string | null;
  hint?: string;
  source?: string;
}) {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
      <p className="text-xs uppercase tracking-wide text-white/40">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value ?? <span className="text-white/30 text-base">Not available</span>}</p>
      {hint ? <p className="mt-1 text-xs text-white/40">{hint}</p> : null}
      {source ? <p className="mt-1 text-[11px] text-white/25">Source: {source}</p> : null}
    </div>
  );
}

export function AnalyticsDashboard() {
  const accountsQuery = useAccounts();
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [sortBy, setSortBy] = useState("performance_score");

  const accounts = accountsQuery.data ?? [];
  const accountId = selectedAccountId || accounts[0]?.id || "";

  const overviewQuery = useAnalyticsOverview(accountId || null);
  const postsQuery = useAnalyticsPosts(accountId || null, sortBy);
  const growthQuery = useAnalyticsGrowth(accountId || null);
  const runAgent = useRunAnalyticsAgent();

  const overview = overviewQuery.data;
  const posts = postsQuery.data ?? [];
  const growth = growthQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-surface-border bg-surface-raised p-5">
        <select
          value={accountId}
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
          onClick={() => accountId && runAgent.mutate(accountId)}
          disabled={!accountId || runAgent.isPending}
          className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
        >
          {runAgent.isPending ? "Analyzing…" : "Run analytics agent"}
        </button>

        {overview ? (
          <span className="text-xs text-white/40">
            {overview.content.withAnalytics} of {overview.content.published} published posts have analytics
          </span>
        ) : null}
        {runAgent.isError ? <span className="text-sm text-rose-400">{(runAgent.error as Error).message}</span> : null}
      </div>

      {overviewQuery.isLoading ? <p className="text-sm text-white/40">Loading analytics…</p> : null}
      {overviewQuery.isError ? (
        <p className="text-sm text-rose-400">{(overviewQuery.error as Error).message}</p>
      ) : null}

      {overview ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Followers"
              value={overview.followers.current?.toLocaleString() ?? null}
              hint={
                overview.followers.change !== undefined
                  ? `${overview.followers.change >= 0 ? "+" : ""}${overview.followers.change} over ${overview.followers.observations} snapshots`
                  : "Needs at least two daily snapshots"
              }
              source="Instagram account snapshots"
            />
            <Stat
              label="Posts published"
              value={overview.content.published.toLocaleString()}
              hint={`${overview.content.withAnalytics} measured`}
              source="content_posts"
            />
            <Stat
              label="Average reach"
              value={overview.content.averageReach ? Math.round(overview.content.averageReach).toLocaleString() : null}
              hint="Mean of latest per-post snapshots"
              source="Instagram media insights"
            />
            <Stat
              label="Average engagement rate"
              value={
                overview.content.averageEngagementRate !== undefined
                  ? `${(overview.content.averageEngagementRate * 100).toFixed(2)}%`
                  : null
              }
              hint="(likes + comments + shares + saves) / reach"
              source="Derived, computed in-app"
            />
          </div>

          <FollowerGrowthChart growth={growth} />

          <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-white">Top performing content</h3>
                <p className="text-xs text-white/40">
                  Latest snapshot per post · baseline from {overview.baseline.sampleSize} post(s) (median)
                </p>
              </div>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-white"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    Sort by {option.label}
                  </option>
                ))}
              </select>
            </div>

            {posts.length === 0 ? (
              <p className="text-sm text-white/40">
                No analytics collected yet. Publish a post — collection is scheduled automatically.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-white/40">
                    <tr>
                      <th className="pb-2">Published</th>
                      <th className="pb-2">Score</th>
                      <th className="pb-2">Reach</th>
                      <th className="pb-2">Views</th>
                      <th className="pb-2">Likes</th>
                      <th className="pb-2">Shares</th>
                      <th className="pb-2">Saves</th>
                      <th className="pb-2">Follows</th>
                      <th className="pb-2">Engagement</th>
                      <th className="pb-2">Data</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border">
                    {posts.map((post) => (
                      <PostRow key={post.contentPostId ?? post.externalPostId} post={post} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
            <h3 className="mb-1 text-sm font-medium text-white">Agent observations</h3>
            <p className="mb-4 text-xs text-white/40">
              Evidence-backed observations. Phase 5 measures and explains — it does not change strategy.
            </p>
            {overview.insights.length === 0 ? (
              <p className="text-sm text-white/40">No observations yet. Run the analytics agent once posts are measured.</p>
            ) : (
              <ul className="space-y-3">
                {overview.insights.map((insight) => (
                  <li key={insight.id} className="rounded-lg border border-surface-border p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-white/40">
                      <span className="rounded bg-white/10 px-2 py-0.5 text-white/70">{insight.type}</span>
                      {insight.dimensionValue ? <span>{insight.dimensionValue}</span> : null}
                      {insight.confidence !== undefined ? (
                        <span>confidence {(insight.confidence * 100).toFixed(0)}%</span>
                      ) : null}
                      {insight.sampleSize !== undefined ? <span>n={insight.sampleSize}</span> : null}
                    </div>
                    <p className="mt-1 text-sm text-white/80">{insight.finding}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function PostRow({ post }: { post: AnalyticsPostDto }) {
  const byName = Object.fromEntries(post.metrics.map((m) => [m.name, m]));

  return (
    <tr className="text-white/70">
      <td className="py-2">
        {post.publishedAt ? (
          <>
            <div className="text-white">{new Date(post.publishedAt).toLocaleDateString()}</div>
            <div className="text-xs text-white/30">
              {post.postingDayUtc} {post.postingHourUtc}:00 UTC
              {post.generationVersion ? ` · v${post.generationVersion}` : ""}
            </div>
          </>
        ) : (
          <span className="text-white/30">Unknown</span>
        )}
      </td>
      <td className="py-2">
        {post.performanceScore !== undefined ? (
          <span className="text-white" title={post.performanceScoreFormula}>
            {post.performanceScore.toFixed(2)}×
            {post.performanceScoreCoverage < 1 ? (
              <span className="ml-1 text-xs text-amber-400/70">
                ({Math.round(post.performanceScoreCoverage * 100)}%)
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-white/30">Not available</span>
        )}
      </td>
      <td className="py-2"><MetricCell metric={byName.reach} /></td>
      <td className="py-2"><MetricCell metric={byName.views} /></td>
      <td className="py-2"><MetricCell metric={byName.likes} /></td>
      <td className="py-2"><MetricCell metric={byName.shares} /></td>
      <td className="py-2"><MetricCell metric={byName.saves} /></td>
      <td className="py-2"><MetricCell metric={byName.follows} /></td>
      <td className="py-2"><MetricCell metric={byName.engagement_rate} kind="ratio" /></td>
      <td className="py-2">{post.outcome ? <StatusBadge status={post.outcome} /> : null}</td>
    </tr>
  );
}
