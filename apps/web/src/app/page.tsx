import { TopBar } from "@/components/layout/top-bar";
import { StatCard } from "@/components/ui/stat-card";
import { GrowthChart } from "@/components/charts/growth-chart";
import { ActivityTimeline } from "@/components/agent/activity-timeline";
import { dashboardStats, growthSeries, agentActivity } from "@/lib/mock-data";

export default function DashboardPage() {
  return (
    <div>
      <TopBar title="Dashboard" description="Overview of account growth and recent agent activity" />
      <div className="space-y-6 p-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {dashboardStats.map((stat) => (
            <StatCard key={stat.label} stat={stat} />
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <h2 className="mb-3 text-sm font-medium text-white/70">Follower growth (7 days)</h2>
            <GrowthChart data={growthSeries} />
          </div>
          <div>
            <h2 className="mb-3 text-sm font-medium text-white/70">Recent agent activity</h2>
            <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
              <ActivityTimeline items={agentActivity} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
