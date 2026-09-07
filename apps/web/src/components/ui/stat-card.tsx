import clsx from "clsx";
import type { StatSummary } from "@/lib/mock-data";

const TREND_COLOR: Record<StatSummary["trend"], string> = {
  up: "text-emerald-400",
  down: "text-rose-400",
  flat: "text-white/40",
};

export function StatCard({ stat }: { stat: StatSummary }) {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
      <p className="text-xs uppercase tracking-wide text-white/40">{stat.label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{stat.value}</p>
      <p className={clsx("mt-1 text-xs font-medium", TREND_COLOR[stat.trend])}>{stat.delta}</p>
    </div>
  );
}
