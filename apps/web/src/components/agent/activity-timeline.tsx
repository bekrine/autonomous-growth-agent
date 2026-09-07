import type { AgentActivityItem } from "@/lib/mock-data";
import { StatusBadge } from "@/components/ui/status-badge";

export function ActivityTimeline({ items }: { items: AgentActivityItem[] }) {
  return (
    <ol className="relative border-l border-surface-border pl-6">
      {items.map((item) => (
        <li key={item.id} className="mb-6 last:mb-0">
          <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-sky-400" />
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium capitalize text-white">
              {item.agentName.replace(/_/g, " ")} &mdash; {item.decision.replace(/_/g, " ")}
            </p>
            <StatusBadge status={item.status} />
          </div>
          <p className="mt-1 text-sm text-white/60">{item.reason}</p>
          <p className="mt-1 text-xs text-white/30">
            {new Date(item.timestamp).toLocaleString()} · run {item.runId}
          </p>
        </li>
      ))}
    </ol>
  );
}
