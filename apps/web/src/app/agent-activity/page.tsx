import { TopBar } from "@/components/layout/top-bar";
import { ActivityTimeline } from "@/components/agent/activity-timeline";
import { agentActivity } from "@/lib/mock-data";

export default function AgentActivityPage() {
  return (
    <div>
      <TopBar title="Agent Activity" description="Full decision/action log across agent runs" />
      <div className="p-8">
        <div className="rounded-xl border border-surface-border bg-surface-raised p-6">
          <ActivityTimeline items={agentActivity} />
        </div>
      </div>
    </div>
  );
}
