"use client";

import { useState } from "react";
import {
  useAccounts,
  useExperimentDetail,
  useExperimentLifecycle,
  useExperimentProgress,
  useExperiments,
  useProposeExperiment,
  type ExperimentDto,
} from "@/lib/api";
import { StatusBadge } from "@/components/ui/status-badge";
import { ExperimentComparison } from "./experiment-comparison";

/**
 * Experiments list + detail.
 *
 * Progress is always shown as "published / target" rather than a bare
 * percentage, so an experiment that looks decisive but has three posts is
 * visibly not ready.
 */

const ACTIVE_STATUSES = new Set(["draft", "ready", "running", "analyzing", "paused"]);
const INCONCLUSIVE_STATUSES = new Set(["inconclusive", "aborted", "cancelled", "failed"]);

export function ExperimentsPanel() {
  const accountsQuery = useAccounts();
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);

  const accounts = accountsQuery.data ?? [];
  const accountId = selectedAccountId || accounts[0]?.id || "";

  const experimentsQuery = useExperiments(accountId || null);
  const propose = useProposeExperiment();

  const experiments = experimentsQuery.data ?? [];
  const active = experiments.filter((e) => ACTIVE_STATUSES.has(e.status));
  const completed = experiments.filter((e) => e.status === "completed");
  const other = experiments.filter((e) => INCONCLUSIVE_STATUSES.has(e.status));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-surface-border bg-surface-raised p-5">
        <select
          value={accountId}
          onChange={(e) => {
            setSelectedAccountId(e.target.value);
            setSelectedExperimentId(null);
          }}
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
          onClick={() => accountId && propose.mutate(accountId)}
          disabled={!accountId || propose.isPending}
          className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
        >
          {propose.isPending ? "Designing…" : "Propose experiment"}
        </button>

        <span className="text-xs text-white/40">
          A proposal is reviewed before it runs — nothing starts automatically.
        </span>
      </div>

      {propose.data ? <ProposalCard proposal={propose.data} /> : null}
      {propose.isError ? <p className="text-sm text-rose-400">{(propose.error as Error).message}</p> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-6">
          <ExperimentGroup title="Active" experiments={active} onSelect={setSelectedExperimentId} selected={selectedExperimentId} />
          <ExperimentGroup title="Completed" experiments={completed} onSelect={setSelectedExperimentId} selected={selectedExperimentId} />
          <ExperimentGroup
            title="Inconclusive & closed"
            experiments={other}
            onSelect={setSelectedExperimentId}
            selected={selectedExperimentId}
          />
        </div>

        <div>
          {selectedExperimentId ? (
            <ExperimentDetail experimentId={selectedExperimentId} />
          ) : (
            <p className="rounded-xl border border-surface-border bg-surface-raised p-5 text-sm text-white/40">
              Select an experiment to see its hypothesis, arms, progress and result.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ExperimentGroup({
  title,
  experiments,
  onSelect,
  selected,
}: {
  title: string;
  experiments: ExperimentDto[];
  onSelect: (id: string) => void;
  selected: string | null;
}) {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
      <h3 className="mb-3 text-xs uppercase tracking-wide text-white/40">
        {title} ({experiments.length})
      </h3>
      {experiments.length === 0 ? (
        <p className="text-sm text-white/30">None.</p>
      ) : (
        <ul className="space-y-2">
          {experiments.map((experiment) => (
            <li key={experiment.id}>
              <button
                onClick={() => onSelect(experiment.id)}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  selected === experiment.id
                    ? "border-sky-500/50 bg-sky-500/5"
                    : "border-surface-border hover:bg-white/5"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-white">{experiment.name}</span>
                  <StatusBadge status={experiment.status} />
                </div>
                <p className="mt-1 text-xs text-white/40">
                  {experiment.variable ?? "?"} · {experiment.primaryMetric ?? "?"}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExperimentDetail({ experimentId }: { experimentId: string }) {
  const detailQuery = useExperimentDetail(experimentId);
  const progressQuery = useExperimentProgress(experimentId);
  const lifecycle = useExperimentLifecycle(experimentId);

  const detail = detailQuery.data;
  const progress = progressQuery.data;
  if (!detail) return <p className="text-sm text-white/40">Loading…</p>;

  const { experiment, variants, evaluations, posts } = detail;
  const latest = evaluations[0];

  return (
    <div className="space-y-5">
      <div className="space-y-3 rounded-xl border border-surface-border bg-surface-raised p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-medium text-white">{experiment.name}</h2>
          <StatusBadge status={experiment.status} />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-white/40">Hypothesis</dt>
          <dd className="text-white/80">{experiment.hypothesis ?? "—"}</dd>
          <dt className="text-white/40">Variable</dt>
          <dd className="text-white/80">{experiment.variable ?? "—"}</dd>
          <dt className="text-white/40">Primary metric</dt>
          <dd className="text-white/80">{experiment.primaryMetric ?? "—"}</dd>
          <dt className="text-white/40">Min samples / arm</dt>
          <dd className="text-white/80">{experiment.minSamplesPerVariant ?? "—"}</dd>
          <dt className="text-white/40">Min relative lift</dt>
          <dd className="text-white/80">
            {experiment.minRelativeLift ? `${(Number(experiment.minRelativeLift) * 100).toFixed(0)}%` : "—"}
          </dd>
        </dl>

        {experiment.statusReason ? <p className="text-sm text-amber-400/80">{experiment.statusReason}</p> : null}

        <div className="flex flex-wrap gap-2 pt-1">
          <ActionButton label="Start" mutation={lifecycle.start} disabled={!["draft", "ready", "paused"].includes(experiment.status)} />
          <ActionButton label="Pause" mutation={lifecycle.pause} disabled={experiment.status !== "running"} />
          <ActionButton label="Evaluate" mutation={lifecycle.evaluate} disabled={!["running", "analyzing"].includes(experiment.status)} />
          <ActionButton label="Cancel" mutation={lifecycle.cancel} disabled={["completed", "cancelled", "inconclusive"].includes(experiment.status)} />
        </div>
      </div>

      <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
        <h3 className="mb-3 text-xs uppercase tracking-wide text-white/40">Arms & progress</h3>
        <ul className="space-y-3">
          {variants.map((variant) => {
            const armProgress = progress?.variants.find((v) => v.variantId === variant.id);
            const published = armProgress?.published ?? 0;
            const target = armProgress?.target ?? experiment.minSamplesPerVariant ?? 0;
            const pct = target > 0 ? Math.min(100, (published / target) * 100) : 0;

            return (
              <li key={variant.id} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-white/80">
                    {variant.name}
                    <span className="ml-2 text-xs uppercase tracking-wide text-white/30">{variant.role}</span>
                    {variant.status !== "active" ? (
                      <span className="ml-2 text-xs text-rose-400/70">{variant.status}</span>
                    ) : null}
                  </span>
                  {/* Absolute counts, not just a bar. */}
                  <span className="text-xs text-white/50">
                    {published} / {target} published
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-surface">
                  <div className="h-full bg-sky-500/60" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-xs text-white/30">value: {variant.variableValue ?? "—"}</p>
              </li>
            );
          })}
        </ul>

        {progress && !progress.readyToEvaluate ? (
          <p className="mt-3 text-xs text-amber-400/70">
            Not yet ready to evaluate — every arm needs {progress.target} published posts.
          </p>
        ) : null}
      </div>

      {latest ? <ExperimentComparison evaluation={latest} /> : (
        <p className="rounded-xl border border-surface-border bg-surface-raised p-5 text-sm text-white/40">
          No evaluation recorded yet.
        </p>
      )}

      {evaluations.length > 1 ? (
        <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
          <h3 className="mb-2 text-xs uppercase tracking-wide text-white/40">Earlier evaluations</h3>
          <ul className="space-y-1 text-xs text-white/50">
            {evaluations.slice(1).map((evaluation) => (
              <li key={evaluation.id}>
                {new Date(evaluation.evaluatedAt).toLocaleString()} — {evaluation.outcome} (
                {Object.entries(evaluation.sampleSizes)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ")}
                )
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
        <h3 className="mb-2 text-xs uppercase tracking-wide text-white/40">Posts ({posts.length})</h3>
        {posts.length === 0 ? (
          <p className="text-sm text-white/30">No content attached yet.</p>
        ) : (
          <ul className="space-y-1 text-xs text-white/50">
            {posts.map((post) => {
              const variant = variants.find((v) => v.id === post.experimentVariantId);
              return (
                <li key={post.id} className="flex items-center gap-2">
                  <span className="text-white/70">{variant?.name ?? "unassigned"}</span>
                  <span>{post.status}</span>
                  {post.publishedAt ? <span>{new Date(post.publishedAt).toLocaleDateString()}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  mutation,
  disabled,
}: {
  label: string;
  mutation: { mutate: () => void; isPending: boolean; isError: boolean; error: unknown };
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => mutation.mutate()}
      disabled={disabled || mutation.isPending}
      title={mutation.isError ? String((mutation.error as Error)?.message ?? "") : undefined}
      className="rounded-md border border-surface-border px-3 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {mutation.isPending ? "…" : label}
    </button>
  );
}

function ProposalCard({ proposal }: { proposal: Record<string, unknown> }) {
  const design = (proposal.proposal ?? {}) as Record<string, unknown>;
  if (!design.hypothesis) {
    return (
      <p className="rounded-xl border border-surface-border bg-surface-raised p-5 text-sm text-white/50">
        The agent could not produce a proposal: {String(proposal.error ?? "no design returned")}
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-sky-500/30 bg-sky-500/5 p-5">
      <h3 className="text-sm font-medium text-white">Proposed experiment (not created)</h3>
      <p className="text-sm text-white/80">{String(design.hypothesis)}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-white/50">
        <dt>Variable</dt>
        <dd className="text-white/70">{String(design.variable)}</dd>
        <dt>Primary metric</dt>
        <dd className="text-white/70">{String(design.primaryMetric)}</dd>
        <dt>Control</dt>
        <dd className="text-white/70">{String((design.control as Record<string, unknown>)?.variableValue)}</dd>
        <dt>Variant</dt>
        <dd className="text-white/70">{String((design.variant as Record<string, unknown>)?.variableValue)}</dd>
        <dt>Confidence</dt>
        <dd className="text-white/70">{String(design.confidence)}</dd>
      </dl>
      <p className="text-xs text-white/40">{String(design.rationale ?? "")}</p>
    </div>
  );
}
