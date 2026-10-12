"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Logo } from "@/components/Logo";
import { Pet } from "@/components/Pet";
import { useAppData } from "@/lib/app-data";
import { MOOD_LABEL } from "@/lib/pet";
import { formatTaz, ofType } from "@/lib/records";
import { useSession } from "@/lib/session";
import type { WorkspaceMode } from "@/lib/workspace";

const NAV: { href: string; label: string; icon: string; team?: boolean }[] = [
  { href: "/app", label: "Home", icon: "🏠" },
  { href: "/app/treasury", label: "Treasury", icon: "🏦" },
  { href: "/app/payroll", label: "Payroll", icon: "💸", team: true },
  { href: "/app/payments", label: "Payments", icon: "🧾" },
  { href: "/app/books", label: "Books", icon: "📒" },
  { href: "/app/kudos", label: "Kudos", icon: "💖", team: true },
  { href: "/app/auctions", label: "Auctions", icon: "🔨" },
  { href: "/app/team", label: "Team & policy", icon: "👥" },
];

/** Sections for this kind of workspace; personal ones hide team-only pages. */
export function navFor(mode: WorkspaceMode) {
  return mode === "team"
    ? NAV
    : NAV.filter((n) => !n.team).map((n) => (n.href === "/app/team" ? { ...n, label: "Settings", icon: "⚙️" } : n));
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { setSession } = useSession();
  const { session, mood, vitals, error, mode } = useAppData();
  const nav = navFor(mode);
  const active = (href: string) => (href === "/app" ? pathname === "/app" : pathname.startsWith(href));
  // On phones the tab row scrolls; keep the current page's tab in view.
  const tabs = useRef<HTMLElement>(null);
  useEffect(() => {
    tabs.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [pathname]);

  return (
    <div className="flex min-h-full flex-1 flex-col print:block">
      <header className="sticky top-0 z-20 border-b-[3px] border-border bg-surface print:hidden">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Link href="/app" className="flex shrink-0 items-center" aria-label="Zebfin home">
              <Logo className="h-7" />
            </Link>
            <span className="chip hidden max-w-48 truncate sm:inline-flex">{session.orgName}</span>
            <span className="chip chip-sun">testnet</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted md:inline">🔒 End-to-end encrypted</span>
            <span className="lg:hidden" title={`Zeb is ${MOOD_LABEL[mood].toLowerCase()}`}>
              <Pet mood={mood} size={32} />
            </span>
            <button
              className="btn-ghost px-3 py-1 text-xs"
              onClick={() => {
                setSession(null);
                router.push("/");
              }}
            >
              Lock
            </button>
          </div>
        </div>
        {/* Phones and tablets: a scrolling row of tabs. */}
        <nav ref={tabs} className="flex gap-2 overflow-x-auto px-4 pb-2.5 lg:hidden" aria-label="Sections">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n.href) ? "page" : undefined}
              className={`${active(n.href) ? "btn" : "btn-ghost"} shrink-0 px-3 py-1 text-xs`}
            >
              <span aria-hidden>{n.icon}</span> {n.label}
            </Link>
          ))}
        </nav>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-6 px-4 py-6">
        <aside className="hidden w-56 shrink-0 lg:block print:hidden">
          <div className="sticky top-20 space-y-4">
            <nav className="card space-y-1 p-2" aria-label="Sections">
              {nav.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active(n.href) ? "page" : undefined}
                  className={`display flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${
                    active(n.href) ? "bg-accent text-[#2a2036] shadow-[inset_0_0_0_2px_var(--border)]" : "hover:bg-accent-soft"
                  }`}
                >
                  <span aria-hidden className="text-base">
                    {n.icon}
                  </span>
                  {n.label}
                </Link>
              ))}
            </nav>
            <Link href="/app" className="screen flex items-center gap-3 p-3" title="Zeb, your treasury pet">
              <Pet mood={mood} size={48} />
              <span className="min-w-0 text-xs leading-tight">
                <span className="block">ZEB · {MOOD_LABEL[mood].toUpperCase()}</span>
                <span className="block opacity-75">{vitals?.totalZats != null ? `${formatTaz(vitals.totalZats)} TAZ` : "…"}</span>
              </span>
            </Link>
          </div>
        </aside>
        <main className="min-w-0 flex-1">
          {error && <p className="card mb-4 text-sm text-danger">{error}</p>}
          {children}
        </main>
      </div>
    </div>
  );
}

/** Title row for a dashboard page. */
export function PageHeader({ title, blurb, children }: { title: string; blurb?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 print:hidden">
      <div>
        <h1 className="text-2xl sm:text-3xl">{title}</h1>
        {blurb && <p className="mt-1 max-w-2xl text-sm text-muted">{blurb}</p>}
      </div>
      {children}
    </div>
  );
}

/** Picks which treasury account a page acts on (shown only with several accounts). */
export function AccountPicker() {
  const { accounts, records, selected, setSelected } = useAppData();
  if (accounts.length < 2) return null;
  const labels = ofType(records, "account");
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="label mb-0">Account</span>
      <select className="input w-auto" value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
        {accounts.map((a) => (
          <option key={a} value={a}>
            {labels.find((l) => l.value.accountId === a)?.value.name ?? `Account ${a.slice(0, 8)}`}
          </option>
        ))}
      </select>
    </label>
  );
}
