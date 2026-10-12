"use client";

import { PageHeader } from "@/components/AppShell";
import { KudosTab } from "@/components/KudosTab";
import { useAppData } from "@/lib/app-data";

export default function KudosPage() {
  const { session, records, accounts, reload } = useAppData();
  return (
    <>
      <PageHeader title="Kudos" blurb="Teammates thank each other with small amounts. Everyone sees the thanks; nobody sees the amounts." />
      <KudosTab session={session} records={records} accounts={accounts} onChanged={reload} />
    </>
  );
}
