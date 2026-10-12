"use client";

import { PageHeader } from "@/components/AppShell";
import { Treasury } from "@/components/Treasury";
import { useAppData } from "@/lib/app-data";
import { ofType } from "@/lib/records";

export default function TreasuryPage() {
  const { session, records, accounts, selected, setSelected, reload } = useAppData();
  return (
    <>
      <PageHeader title="Treasury" blurb="Your shielded accounts: balances, activity and fresh receiving addresses." />
      <div className="max-w-4xl">
        <Treasury
          session={session}
          accounts={accounts}
          labels={ofType(records, "account")}
          selected={selected}
          onSelect={setSelected}
          onChanged={reload}
        />
      </div>
    </>
  );
}
