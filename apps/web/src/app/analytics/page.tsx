import { TopBar } from "@/components/layout/top-bar";
import { StatCard } from "@/components/ui/stat-card";
import { GrowthChart } from "@/components/charts/growth-chart";
import { dashboardStats, growthSeries } from "@/lib/mock-data";

export default function AnalyticsPage() {
  return (
    <div>
      <TopBar title="Analytics" description="Account and post-level performance snapshots" />
      <div className="space-y-6 p-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {dashboardStats.map((stat) => (
            <StatCard key={stat.label} stat={stat} />
          ))}
        </div>
        <GrowthChart data={growthSeries} />
      </div>
    </div>
  );
}
