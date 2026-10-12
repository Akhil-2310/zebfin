"use client";

import Link from "next/link";
import { GettingStarted } from "@/components/GettingStarted";
import { PetHero } from "@/components/PetHero";
import { useAppData } from "@/lib/app-data";
import { formatTaz, ofType } from "@/lib/records";
import { ordinal } from "@/lib/schedule";

export default function Home() {
  const { session, records, accounts, reload, vitals, payday, mode } = useAppData();
  const schedule = ofType(records, "payroll-schedule")[0]?.value;
  const contributors = ofType(records, "contributor");
  const invoices = ofType(records, "invoice");
  const auctions = ofType(records, "auction");
  const teamTiles = [
    {
      href: "/app/treasury",
      icon: "🏦",
      label: "Treasury",
      value: vitals?.totalZats != null ? `${formatTaz(vitals.totalZats)} TAZ` : accounts.length ? "…" : "Not set up",
      note: vitals?.usd != null ? `≈ $${vitals.usd.toFixed(2)}` : "Shielded balance",
    },
    {
      href: "/app/payments",
      icon: "✅",
      label: "In progress",
      value: vitals ? `${vitals.pending} payment${vitals.pending === 1 ? "" : "s"}` : "…",
      note: "Waiting on approvals or signing",
    },
    {
      href: "/app/payroll",
      icon: "📅",
      label: "Pay day",
      value: payday ? "Today!" : schedule ? `The ${ordinal(schedule.dayOfMonth)}` : "Not set",
      note: payday ? "The run is ready to fill in" : "Monthly payroll",
    },
    {
      href: "/app/payroll",
      icon: "🧑‍🤝‍🧑",
      label: "Contributors",
      value: `${contributors.length} ${contributors.length === 1 ? "person" : "people"}`,
      note: "Paid privately",
    },
  ];
  const personalTiles = [
    {
      href: "/app/payments",
      icon: "🧾",
      label: "Invoices",
      value: `${invoices.length} sent`,
      note: "Paid privately by QR or link",
    },
    {
      href: "/app/auctions",
      icon: "🔨",
      label: "Auctions",
      value: `${auctions.length} ${auctions.length === 1 ? "auction" : "auctions"}`,
      note: "Sealed bids, open to anyone",
    },
  ];
  const tiles = [...teamTiles.slice(0, 2), ...(mode === "team" ? teamTiles.slice(2) : personalTiles)];

  return (
    <div className="space-y-6">
      <PetHero />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href} className="card block p-4 transition-transform hover:-translate-y-0.5">
            <p className="label">
              <span aria-hidden>{t.icon}</span> {t.label}
            </p>
            <p className="display text-lg sm:text-xl">{t.value}</p>
            <p className="text-xs text-muted">{t.note}</p>
          </Link>
        ))}
      </div>
      <GettingStarted session={session} records={records} accounts={accounts} onChanged={reload} />
    </div>
  );
}
