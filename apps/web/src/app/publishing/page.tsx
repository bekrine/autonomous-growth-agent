import { TopBar } from "@/components/layout/top-bar";
import { PublishingJobsPanel } from "@/components/publishing/publishing-jobs-panel";

export default function PublishingPage() {
  return (
    <div>
      <TopBar
        title="Publishing"
        description="Scheduled, in-flight and completed publishing jobs"
      />
      <div className="p-8">
        <PublishingJobsPanel />
      </div>
    </div>
  );
}
