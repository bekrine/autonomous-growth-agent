import { TopBar } from "@/components/layout/top-bar";

export default function StrategyPage() {
  return (
    <div>
      <TopBar title="Strategy" description="Current strategy version and history for this account" />
      <div className="p-8">
        <div className="rounded-xl border border-surface-border bg-surface-raised p-6">
          <p className="text-sm font-medium text-white">Current focus</p>
          <p className="mt-2 text-sm text-white/60">
            Short-form, behind-the-scenes debugging content performs above account baseline; strategy
            proposes doubling down on this format for the next cycle.
          </p>
          <p className="mt-4 text-xs uppercase tracking-wide text-white/30">
            Strategy versioning and approval history will render here once wired to the API.
          </p>
        </div>
      </div>
    </div>
  );
}
