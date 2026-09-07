export function TopBar({ title, description }: { title: string; description?: string }) {
  return (
    <header className="flex items-center justify-between border-b border-surface-border px-8 py-5">
      <div>
        <h1 className="text-lg font-semibold text-white">{title}</h1>
        {description ? <p className="mt-1 text-sm text-white/50">{description}</p> : null}
      </div>
      <div className="flex items-center gap-2 rounded-full border border-surface-border bg-surface-raised px-3 py-1.5 text-xs text-white/60">
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
        Autonomy: Active
      </div>
    </header>
  );
}
