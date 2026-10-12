"use client";

import { AccountPicker, PageHeader } from "@/components/AppShell";
import { Invoices } from "@/components/Invoices";
import { Payments } from "@/components/Payments";
import { useAppData } from "@/lib/app-data";
import { ofType } from "@/lib/records";

export default function PaymentsPage() {
  const { session, records, accounts, selected, reload } = useAppData();
  return (
    <>
      <PageHeader title="Payments" blurb="Request and approve one-off payments, keep a payee book, and invoice customers.">
        <AccountPicker />
      </PageHeader>
      {selected ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <Payments
            session={session}
            accountId={selected}
            accounts={accounts}
            accountLabels={ofType(records, "account")}
            payees={ofType(records, "payee")}
            notes={ofType(records, "request-note")}
            memberLabels={ofType(records, "member")}
            onChanged={reload}
          />
          <Invoices session={session} accountId={selected} invoices={ofType(records, "invoice")} onChanged={reload} />
        </div>
      ) : (
        <p className="card text-sm text-muted">🥚 Connect a treasury account first.</p>
      )}
    </>
  );
}
