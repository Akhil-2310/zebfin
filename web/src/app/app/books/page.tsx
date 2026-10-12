"use client";

import { PageHeader } from "@/components/AppShell";
import { Books } from "@/components/Books";
import { useAppData } from "@/lib/app-data";

export default function BooksPage() {
  const { session, records, accounts, reload } = useAppData();
  return (
    <>
      <PageHeader title="Books" blurb="A ledger built in your browser from your viewing keys: reconciled, categorized and exportable." />
      {accounts.length ? (
        <Books session={session} accounts={accounts} records={records} onChanged={reload} />
      ) : (
        <p className="card text-sm text-muted">🥚 Connect a treasury account to see the books.</p>
      )}
    </>
  );
}
