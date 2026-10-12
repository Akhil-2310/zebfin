"use client";

import { useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Members } from "@/components/Members";
import { PolicyPanel } from "@/components/PolicyPanel";
import { ServerView } from "@/components/ServerView";
import { useAppData } from "@/lib/app-data";
import { ofType, saveRecord } from "@/lib/records";
import { workspaceRecordId, type WorkspaceMode } from "@/lib/workspace";

export default function TeamPage() {
  const { session, records, mode } = useAppData();
  const personal = mode === "personal";
  return (
    <>
      <PageHeader
        title={personal ? "Settings" : "Team & policy"}
        blurb={
          personal
            ? "Your workspace, approval rules, and exactly what our server can see."
            : "Who's in your org, who approves payments, and exactly what our server can see."
        }
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="space-y-5">
          <WorkspaceCard />
          <Members session={session} labels={ofType(records, "member")} />
          <PolicyPanel session={session} memberLabels={ofType(records, "member")} />
        </div>
        <ServerView records={records} />
      </div>
    </>
  );
}

const MODES: Record<WorkspaceMode, { title: string; blurb: string }> = {
  personal: { title: "🧑 Personal", blurb: "Treasury, payroll, payments, invoices, books and auctions." },
  team: { title: "🏢 Team", blurb: "Adds teammates with shared approvals, and kudos." },
};

function WorkspaceCard() {
  const { session, records, mode, reload } = useAppData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const other: WorkspaceMode = mode === "personal" ? "team" : "personal";

  async function switchTo(m: WorkspaceMode) {
    setBusy(true);
    setError(null);
    try {
      await saveRecord(session, { type: "workspace", mode: m }, workspaceRecordId(records));
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="text-lg">Workspace</h2>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="display">{MODES[mode].title}</p>
          <p className="text-xs text-muted">{MODES[mode].blurb}</p>
        </div>
        <button className="btn-ghost px-3 py-1 text-xs" disabled={busy} onClick={() => switchTo(other)}>
          Switch to {other}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        Only changes which sections you see; nothing is deleted. Stored encrypted, so our server doesn&apos;t know which
        kind of workspace this is.
      </p>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
