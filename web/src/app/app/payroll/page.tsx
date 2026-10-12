"use client";

import { AccountPicker, PageHeader } from "@/components/AppShell";
import { Contributors } from "@/components/Contributors";
import { Payroll } from "@/components/Payroll";
import { useAppData } from "@/lib/app-data";
import { ofType } from "@/lib/records";

export default function PayrollPage() {
  const { session, records, selected, reload } = useAppData();
  return (
    <>
      <PageHeader title="Payroll" blurb="Pay your whole team in one shielded transaction, with a private payslip for each person.">
        <AccountPicker />
      </PageHeader>
      <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
        <Payroll
          session={session}
          accountId={selected}
          contributors={ofType(records, "contributor")}
          memberLabels={ofType(records, "member")}
          runs={ofType(records, "run")}
          schedule={ofType(records, "payroll-schedule")[0] ?? null}
          onChanged={reload}
        />
        <Contributors session={session} contributors={ofType(records, "contributor")} onChanged={reload} />
      </div>
    </>
  );
}
