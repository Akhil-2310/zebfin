"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Balance, type MembersResponse, type PolicyView } from "@/lib/api";
import { loadDemoData } from "@/lib/demo";
import { maxApprovals } from "@/lib/policy-presets";
import { workspaceMode } from "@/lib/workspace";
import { ofType, type Stored } from "@/lib/records";
import type { Session } from "@/lib/session";

/** A step-by-step path through the product, ticked off from real state. */
export function GettingStarted({
  session,
  records,
  accounts,
  onChanged,
}: {
  session: Session;
  records: Stored[];
  accounts: string[];
  onChanged: () => void;
}) {
  const router = useRouter();
  const [funded, setFunded] = useState(false);
  const [demo, setDemo] = useState<{ busy: boolean; msg: string | null; error?: boolean }>({ busy: false, msg: null });
  const [teammates, setTeammates] = useState(0);
  const [solo, setSolo] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    try {
      if (localStorage.getItem("zebfin.getting-started.hidden") === "1") setTimeout(() => !cancelled && setHidden(true), 0);
    } catch {}
    Promise.all([
      ...accounts.map((a) => api<Balance>(`/v1/accounts/${a}/balance`, { token: session.token }).catch(() => null)),
    ]).then((bs) => !cancelled && setFunded(bs.some((b) => (b?.total_zats ?? 0) > 0)));
    api<MembersResponse>("/v1/members", { token: session.token }).then((m) => !cancelled && setTeammates(m.members.length - 1), () => {});
    api<PolicyView>("/v1/policy", { token: session.token }).then((v) => !cancelled && setSolo(maxApprovals(v.policy) === 1), () => {});
    return () => {
      cancelled = true;
    };
  }, [accounts, session.token]);

  const contributors = ofType(records, "contributor");
  const personal = workspaceMode(records) === "personal";
  const teamSteps: { label: string; done: boolean; href: string; hint: string }[] = [
    { label: "Connect a treasury account", done: accounts.length > 0, href: "/app/treasury", hint: "New key in this browser" },
    { label: "Fund it with testnet TAZ", done: funded, href: "/app/treasury", hint: "Treasury → 🚰 Get test TAZ" },
    solo
      ? { label: "Approvals: just you", done: true, href: "/app/team", hint: "Spending policy → switch to several of us when your team grows" }
      : { label: "Invite a second approver", done: teammates > 0, href: "/app/team", hint: "Create invite link" },
    { label: "Add a contributor", done: contributors.some((c) => c.value.address), href: "/app/payroll", hint: "Invite by link" },
    { label: "Run payroll", done: ofType(records, "run").some((r) => (r.value.kind ?? "payroll") === "payroll"), href: "/app/payroll", hint: "Payroll run → approve → sign" },
    { label: "Check the books", done: ofType(records, "ledger-note").length + ofType(records, "period-close").length > 0, href: "/app/books", hint: "Categorize or close a month" },
    { label: "Start kudos", done: ofType(records, "kudos-settings").length > 0, href: "/app/kudos", hint: "Start kudos" },
    { label: "Run a sealed-bid auction", done: ofType(records, "auction").length > 0, href: "/app/auctions", hint: "New auction" },
  ];
  const personalSteps: typeof teamSteps = [
    teamSteps[0],
    teamSteps[1],
    { label: "Send an invoice", done: ofType(records, "invoice").length > 0, href: "/app/payments", hint: "Payments → Invoices" },
    { label: "Pay someone", done: ofType(records, "request-note").length > 0, href: "/app/payments", hint: "Payments → Pay someone" },
    teamSteps[5], // check the books
    teamSteps[7], // run a sealed-bid auction
  ];
  const steps = personal ? personalSteps : teamSteps;
  const done = steps.filter((s) => s.done).length;
  // Offer demo data until each demo piece exists (some need a treasury account first).
  const demoMissing = (personal ? (["invoice", "auction"] as const) : (["contributor", "invoice", "kudos-settings", "auction"] as const)).some((t) => !ofType(records, t).length);
  if (hidden || done === steps.length) return null;

  return (
    <section className="card">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg">🐣 Care guide</h2>
        <div className="flex flex-wrap justify-end gap-2">
          {demoMissing && (
            <button
              className="btn px-3 py-1 text-xs"
              disabled={demo.busy}
              title="Adds a sample team, payees, an invoice, kudos and an auction (testnet)"
              onClick={async () => {
                setDemo({ busy: true, msg: "Loading demo data…" });
                try {
                  const done = await loadDemoData(session, accounts, records, (step) => setDemo({ busy: true, msg: step }), personal ? "personal" : "team");
                  setDemo({ busy: false, msg: `Added: ${done.join(", ")}.` });
                } catch (e) {
                  setDemo({ busy: false, msg: e instanceof Error ? e.message : String(e), error: true });
                }
                onChanged();
              }}
            >
              🎲 Load demo data
            </button>
          )}
          <button
            className="btn-ghost px-3 py-1 text-xs"
            onClick={() => {
              setHidden(true);
              try {
                localStorage.setItem("zebfin.getting-started.hidden", "1");
              } catch {}
            }}
          >
            Hide
          </button>
        </div>
      </div>
      {demo.msg && <p className={`mt-2 text-xs ${demo.error ? "text-danger" : "text-ok"}`}>{demo.msg}</p>}
      <div className="mt-2 flex items-center gap-3">
        <div className="meter max-w-xs" role="meter" aria-label="Care guide progress" aria-valuenow={done} aria-valuemin={0} aria-valuemax={steps.length}>
          <span style={{ width: `${(done / steps.length) * 100}%`, color: "var(--accent-strong)" }} />
        </div>
        <span className="display shrink-0 text-xs">
          {done}/{steps.length}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted">
        Raise Zeb by setting up your workspace. Everything stays encrypted in your browser; payments are shielded on Zcash testnet.
      </p>
      <ol className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.label}>
            <button
              className={`flex w-full items-start gap-2 rounded-xl border-2 border-dashed border-border/40 p-2 text-left ${
                s.done ? "text-muted" : "hover:bg-accent-soft"
              }`}
              onClick={() => router.push(s.href)}
              title={s.hint}
            >
              <span
                className="display grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 border-border text-xs"
                style={s.done ? { background: "var(--mint)", color: "#2a2036" } : { background: "var(--surface)" }}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span>
                <span className={s.done ? "line-through" : "font-semibold"}>{s.label}</span>
                {!s.done && <span className="block text-xs text-muted">{s.hint}</span>}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
