"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsGrowthDto } from "@/lib/api";

/**
 * Follower history from real account snapshots.
 *
 * Only observed points are plotted — gaps stay gaps rather than being
 * interpolated, because inventing a follower count for a day we never
 * measured would fabricate the exact history this chart exists to show.
 */
export function FollowerGrowthChart({ growth }: { growth?: AnalyticsGrowthDto }) {
  const points = (growth?.series ?? [])
    .filter((point) => point.followers !== undefined)
    .map((point) => ({
      day: point.day ?? new Date(point.capturedAt).toISOString().slice(0, 10),
      followers: point.followers,
    }));

  return (
    <div className="rounded-xl border border-surface-border bg-surface-raised p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 px-1">
        <div>
          <h3 className="text-sm font-medium text-white">Follower growth</h3>
          <p className="text-xs text-white/40">
            Metric: followers · Source: Instagram account snapshots (daily, UTC)
          </p>
        </div>
        <p className="text-xs text-white/40">
          {points.length > 0
            ? `Range: ${points[0]!.day} → ${points[points.length - 1]!.day}`
            : "No range yet"}
        </p>
      </div>

      <div className="h-64 w-full">
        {points.length < 2 ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-white/40">
            {points.length === 0
              ? "No account snapshots yet — follower history builds once daily collection runs."
              : "Only one snapshot so far. Growth needs at least two days of observations."}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 10, right: 20, bottom: 0, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2530" />
              <XAxis dataKey="day" stroke="#5b6472" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis
                stroke="#5b6472"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                // A 0-based domain flattens small real changes into a straight line.
                domain={["dataMin - 5", "dataMax + 5"]}
                allowDecimals={false}
                tickFormatter={(value: number) => value.toLocaleString()}
              />
              <Tooltip
                contentStyle={{ background: "#11151d", border: "1px solid #1f2530", borderRadius: 8 }}
                labelStyle={{ color: "#e6e9ef" }}
              />
              <Line type="monotone" dataKey="followers" stroke="#38bdf8" strokeWidth={2} dot />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
