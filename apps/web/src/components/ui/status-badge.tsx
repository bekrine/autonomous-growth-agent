import clsx from "clsx";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-400/10 text-emerald-400",
  completed: "bg-emerald-400/10 text-emerald-400",
  published: "bg-emerald-400/10 text-emerald-400",
  succeeded: "bg-emerald-400/10 text-emerald-400",
  running: "bg-sky-400/10 text-sky-400",
  scheduled: "bg-sky-400/10 text-sky-400",
  pending: "bg-amber-400/10 text-amber-400",
  pending_review: "bg-amber-400/10 text-amber-400",
  draft: "bg-white/10 text-white/60",
  disconnected: "bg-white/10 text-white/60",
  aborted: "bg-white/10 text-white/60",
  failed: "bg-rose-400/10 text-rose-400",
  rejected: "bg-rose-400/10 text-rose-400",
  error: "bg-rose-400/10 text-rose-400",
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-white/10 text-white/60";
  return (
    <span className={clsx("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize", style)}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
