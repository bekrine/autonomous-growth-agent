"use client";

import { useMemo, useState } from "react";
import { useCancelPublishingJob, usePublishingJobs, type PublishingJobDto } from "@/lib/api";
import { StatusBadge } from "@/components/ui/status-badge";

/** Dashboard groupings — several backend statuses collapse into one column. */
const GROUPS = [
  { key: "scheduled", label: "Scheduled", statuses: ["scheduled"] },
  { key: "publishing", label: "Publishing", statuses: ["queued", "publishing", "retry_scheduled", "processing"] },
  { key: "published", label: "Published", statuses: ["published", "succeeded"] },
  { key: "failed", label: "Failed", statuses: ["failed"] },
  { key: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
] as const;

type GroupKey = (typeof GROUPS)[number]["key"];

function canCancel(job: PublishingJobDto): boolean {
  return job.status === "scheduled" || job.status === "queued" || job.status === "retry_scheduled";
}

export function PublishingJobsPanel() {
  const jobsQuery = usePublishingJobs();
  const cancel = useCancelPublishingJob();
  const [activeGroup, setActiveGroup] = useState<GroupKey>("publishing");
  const [cancelNote, setCancelNote] = useState<string | null>(null);

  const jobs = useMemo(() => jobsQuery.data ?? [], [jobsQuery.data]);

  const counts = useMemo(() => {
    const map = {} as Record<GroupKey, number>;
    for (const group of GROUPS) {
      map[group.key] = jobs.filter((j) => (group.statuses as readonly string[]).includes(j.status)).length;
    }
    return map;
  }, [jobs]);

  const visible = useMemo(() => {
    const group = GROUPS.find((g) => g.key === activeGroup)!;
    return jobs.filter((j) => (group.statuses as readonly string[]).includes(j.status));
  }, [jobs, activeGroup]);

  async function handleCancel(jobId: string) {
    const result = await cancel.mutateAsync(jobId);
    setCancelNote(result.cancelled ? null : (result.reason ?? "Could not cancel this job."));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {GROUPS.map((group) => (
          <button
            key={group.key}
            onClick={() => setActiveGroup(group.key)}
            className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
              activeGroup === group.key
                ? "border-sky-500 bg-sky-500/10 text-white"
                : "border-surface-border text-white/60 hover:bg-white/5"
            }`}
          >
            {group.label} <span className="text-white/40">({counts[group.key] ?? 0})</span>
          </button>
        ))}
      </div>

      {cancelNote ? <p className="text-sm text-amber-400">{cancelNote}</p> : null}

      <div className="overflow-x-auto rounded-xl border border-surface-border bg-surface-raised">
        <table className="w-full min-w-[52rem] text-left text-sm">
          <thead>
            <tr className="border-b border-surface-border text-xs uppercase tracking-wide text-white/40">
              <th className="px-4 py-3 font-medium">Content</th>
              <th className="px-4 py-3 font-medium">Platform</th>
              <th className="px-4 py-3 font-medium">Scheduled</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Attempts</th>
              <th className="px-4 py-3 font-medium">External post</th>
              <th className="px-4 py-3 font-medium">Published</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {visible.map((job) => (
              <tr key={job.id} className="border-b border-surface-border/60 last:border-0 hover:bg-white/5">
                <td className="px-4 py-3 font-mono text-xs text-white/70">{job.contentPostId.slice(0, 8)}…</td>
                <td className="px-4 py-3 capitalize text-white/70">{job.platform ?? "—"}</td>
                <td className="px-4 py-3 text-white/60">
                  {job.scheduledFor ? new Date(job.scheduledFor).toLocaleString() : "—"}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={job.status} />
                  {job.errorCode ? (
                    <p className="mt-1 text-xs text-rose-400">{job.errorCode}</p>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-white/60">{job.attempts}</td>
                <td className="px-4 py-3 font-mono text-xs text-white/70">{job.externalPostId ?? "—"}</td>
                <td className="px-4 py-3 text-white/60">
                  {job.publishedAt ? new Date(job.publishedAt).toLocaleString() : "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  {canCancel(job) ? (
                    <button
                      onClick={() => void handleCancel(job.id)}
                      disabled={cancel.isPending}
                      className="rounded-md border border-surface-border px-3 py-1 text-xs text-white/70 transition-colors hover:bg-white/5 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-white/30">
                  No jobs in this state.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {visible.some((j) => j.lastError) ? (
        <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
          <h3 className="mb-2 text-xs uppercase tracking-wide text-white/40">Recent errors</h3>
          <ul className="space-y-2">
            {visible
              .filter((j) => j.lastError)
              .map((j) => (
                <li key={j.id} className="text-sm">
                  <span className="font-mono text-xs text-white/50">{j.contentPostId.slice(0, 8)}…</span>{" "}
                  <span className="text-rose-400">{j.errorCode}</span>{" "}
                  <span className="text-white/60">{j.lastError}</span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
