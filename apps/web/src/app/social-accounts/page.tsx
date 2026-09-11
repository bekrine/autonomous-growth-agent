import { TopBar } from "@/components/layout/top-bar";
import { SocialConnectionsPanel } from "@/components/social/social-connections-panel";

export default function SocialAccountsPage() {
  return (
    <div>
      <TopBar
        title="Social Accounts"
        description="Connect the platforms this agent is allowed to publish to"
      />
      <div className="p-8">
        <SocialConnectionsPanel />
      </div>
    </div>
  );
}
