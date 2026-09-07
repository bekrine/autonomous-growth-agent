import { TopBar } from "@/components/layout/top-bar";
import { ContentCard } from "@/components/ui/content-card";
import { contentItems } from "@/lib/mock-data";

export default function ContentPage() {
  return (
    <div>
      <TopBar title="Content" description="Ideas and posts moving through the review/publish pipeline" />
      <div className="grid grid-cols-1 gap-4 p-8 sm:grid-cols-2 lg:grid-cols-3">
        {contentItems.map((item) => (
          <ContentCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
