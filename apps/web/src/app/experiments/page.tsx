import { TopBar } from "@/components/layout/top-bar";
import { ExperimentsPanel } from "@/components/experiments/experiments-panel";

export default function ExperimentsPage() {
  return (
    <div>
      <TopBar
        title="Experiments"
        description="Controlled tests measured against real analytics. Results are recommendations — the strategy is not changed automatically."
      />
      <div className="p-8">
        <ExperimentsPanel />
      </div>
    </div>
  );
}
