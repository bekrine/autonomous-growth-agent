import { TopBar } from "@/components/layout/top-bar";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { socialAccountItems } from "@/lib/mock-data";

export default function SocialAccountsPage() {
  return (
    <div>
      <TopBar title="Social Accounts" description="Connected platforms this agent operates on" />
      <div className="p-8">
        <DataTable
          columns={[
            { header: "Account", render: (row) => <span className="text-white">{row.displayName}</span> },
            { header: "Platform", render: (row) => <span className="capitalize">{row.platform}</span> },
            { header: "Followers", render: (row) => row.followers },
            { header: "Status", render: (row) => <StatusBadge status={row.status} /> },
          ]}
          rows={socialAccountItems}
        />
      </div>
    </div>
  );
}
