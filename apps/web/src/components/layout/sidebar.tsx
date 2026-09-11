"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/strategy", label: "Strategy" },
  { href: "/content", label: "Content" },
  { href: "/publishing", label: "Publishing" },
  { href: "/analytics", label: "Analytics" },
  { href: "/experiments", label: "Experiments" },
  { href: "/agent-activity", label: "Agent Activity" },
  { href: "/social-accounts", label: "Social Accounts" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-surface-border bg-surface-raised px-4 py-6">
      <div className="mb-8 px-2">
        <p className="text-sm font-semibold tracking-tight text-white">Autonomous Growth Agent</p>
        <p className="text-xs text-white/40">Operator Console</p>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-white/10 text-white"
                  : "text-white/60 hover:bg-white/5 hover:text-white",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
