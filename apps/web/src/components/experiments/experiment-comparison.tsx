"use client";

import type { ExperimentEvaluationDto } from "@/lib/api";

/**
 * Horizontal bar comparison of the arms.
 *
 * Sample size is rendered next to every bar, never hidden: a bar twice as long
 * drawn from two posts means something very different from the same bar drawn
 * from twenty, and showing only the bar invites the reader to forget that.
 */

const OUTCOME_LABELS: Record<string, { label: string; tone: string }> = {
  variant_winner: { label: "Directional winner: variant", tone: "text-emerald-400" },
  control_winner: { label: "Directional winner: control", tone: "text-sky-400" },
  no_clear_winner: { label: "No clear winner", tone: "text-white/60" },
  inconclusive: { label: "Inconclusive", tone: "text-amber-400" },
  insufficient_data: { label: "Insufficient data", tone: "text-amber-400" },
};

export function ExperimentComparison({ evaluation }: { evaluation: ExperimentEvaluationDto }) {
  const summaries = evaluation.detail?.summaries ?? [];
  const values = summaries.map((s) => s.median ?? 0);
  const max = Math.max(...values, 0);
  const outcome = OUTCOME_LABELS[evaluation.outcome] ?? { label: evaluation.outcome, tone: "text-white/60" };

  return (
    <div className="space-y-4 rounded-xl border border-surface-border bg-surface-raised p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-white">Comparison</h3>
        <span className={`text-sm font-medium ${outcome.tone}`}>{outcome.label}</span>
      </div>

      <p className="text-xs text-white/40">
        Metric: {evaluation.primaryMetric} (median per arm) · Confidence: {evaluation.confidence ?? "low"} ·
        Evaluated {new Date(evaluation.evaluatedAt).toLocaleString()}
      </p>

      {summaries.length === 0 ? (
        <p className="text-sm text-white/40">No per-arm detail recorded for this evaluation.</p>
      ) : (
        <ul className="space-y-3">
          {summaries.map((summary) => {
            const value = summary.median ?? 0;
            const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
            const isControl = summary.role === "control";

            return (
              <li key={summary.variantId} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-white/80">
                    {summary.name}
                    <span className="ml-2 text-xs uppercase tracking-wide text-white/30">{summary.role}</span>
                  </span>
                  <span className="text-white">
                    {summary.median === undefined ? <span className="text-white/30">Not available</span> : formatValue(value)}
                  </span>
                </div>

                <div className="h-3 w-full overflow-hidden rounded bg-surface">
                  <div
                    className={`h-full ${isControl ? "bg-sky-500/70" : "bg-emerald-500/70"}`}
                    style={{ width: `${width}%` }}
                  />
                </div>

                {/* Sample size is part of the result, not a footnote. */}
                <p className="text-xs text-white/40">
                  n={summary.observations} measured
                  {summary.assigned !== summary.observations ? ` of ${summary.assigned} published` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {evaluation.relativeLift ? (
        <p className="text-sm text-white/70">
          Relative difference: {(Number(evaluation.relativeLift) * 100).toFixed(1)}%
        </p>
      ) : null}

      {evaluation.conclusion ? <p className="text-sm text-white/70">{evaluation.conclusion}</p> : null}

      {evaluation.detail?.reasons && evaluation.detail.reasons.length > 0 ? (
        <details className="text-xs text-white/40">
          <summary className="cursor-pointer">Why this outcome</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {evaluation.detail.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
          {evaluation.detail.thresholds ? (
            <p className="mt-2">
              Thresholds applied:{" "}
              {Object.entries(evaluation.detail.thresholds)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")}
            </p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

function formatValue(value: number): string {
  if (value === 0) return "0";
  return Math.abs(value) < 1 ? value.toFixed(4) : value.toLocaleString();
}
