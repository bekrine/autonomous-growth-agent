import { TopBar } from "@/components/layout/top-bar";
import { ContentGenerationPanel } from "@/components/content/content-generation-panel";

export default function ContentPage() {
  return (
    <div>
      <TopBar
        title="Content"
        description="Turn a planned content idea into reviewed, ready-to-publish content"
      />
      <div className="p-8">
        <ContentGenerationPanel />
      </div>
    </div>
  );
}
