import type { ContentItem } from "@/lib/mock-data";
import { StatusBadge } from "./status-badge";

export function ContentCard({ item }: { item: ContentItem }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-surface-border bg-surface-raised p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-white">{item.title}</p>
        <StatusBadge status={item.status} />
      </div>
      <div className="flex items-center justify-between text-xs text-white/40">
        <span className="capitalize">{item.platform}</span>
        {item.scheduledAt ? <span>{new Date(item.scheduledAt).toLocaleString()}</span> : null}
      </div>
    </div>
  );
}
