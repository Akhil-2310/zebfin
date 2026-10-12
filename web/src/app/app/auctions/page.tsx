"use client";

import { PageHeader } from "@/components/AppShell";
import { AuctionsTab } from "@/components/AuctionsTab";
import { useAppData } from "@/lib/app-data";

export default function AuctionsPage() {
  const { session, records, accounts, reload } = useAppData();
  return (
    <>
      <PageHeader title="Auctions" blurb="Sealed-bid procurement and sales: nobody, including you, can read a bid before bidding closes." />
      <AuctionsTab session={session} records={records} accounts={accounts} onChanged={reload} />
    </>
  );
}
