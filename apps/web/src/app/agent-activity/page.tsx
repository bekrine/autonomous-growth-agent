import { TopBar } from "@/components/layout/top-bar";
import { AgentRunPanel } from "@/components/agent/agent-run-panel";

export default function AgentActivityPage() {
  return (
    <div>
      <TopBar title="Agent Activity" description="Trigger a real agent run and inspect its research, strategy and content plan" />
      <div className="p-8">
        <AgentRunPanel />
      </div>
    </div>
  );
}
