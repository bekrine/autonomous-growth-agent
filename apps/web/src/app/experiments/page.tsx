import { TopBar } from "@/components/layout/top-bar";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { experimentItems } from "@/lib/mock-data";

export default function ExperimentsPage() {
  return (
    <div>
      <TopBar title="Experiments" description="A/B tests the agent is running to validate strategy changes" />
      <div className="p-8">
        <DataTable
          columns={[
            { header: "Name", render: (row) => <span className="text-white">{row.name}</span> },
            { header: "Hypothesis", render: (row) => row.hypothesis },
            { header: "Variants", render: (row) => row.variants },
            { header: "Status", render: (row) => <StatusBadge status={row.status} /> },
          ]}
          rows={experimentItems}
        />
      </div>
    </div>
  );
}
