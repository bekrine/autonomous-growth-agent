"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { growthSeries } from "@/lib/mock-data";

export function GrowthChart({ data }: { data: typeof growthSeries }) {
  return (
    <div className="h-72 w-full rounded-xl border border-surface-border bg-surface-raised p-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 20, bottom: 0, left: -10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2530" />
          <XAxis dataKey="date" stroke="#5b6472" fontSize={12} tickLine={false} axisLine={false} />
          <YAxis
            stroke="#5b6472"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            domain={["dataMin - 100", "dataMax + 100"]}
            tickFormatter={(value: number) => value.toLocaleString()}
          />
          <Tooltip
            contentStyle={{ background: "#11151d", border: "1px solid #1f2530", borderRadius: 8 }}
            labelStyle={{ color: "#e6e9ef" }}
          />
          <Line type="monotone" dataKey="followers" stroke="#38bdf8" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
