import { TopBar } from "@/components/layout/top-bar";
import { AnalyticsDashboard } from "@/components/analytics/analytics-dashboard";

export default function AnalyticsPage() {
  return (
    <div>
      <TopBar
        title="Analytics"
        description="Measured performance from Instagram — raw snapshots, normalized metrics and derived rates"
      />
      <div className="p-8">
        <AnalyticsDashboard />
      </div>
    </div>
  );
}
