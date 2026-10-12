"use client";

import { useEffect, useMemo, useState } from "react";
import { BalanceChart } from "@/components/BalanceChart";
import { api, type Balance, type MembersResponse, type Payment, type RateQuote } from "@/lib/api";
import {
  DEFAULT_CATEGORIES,
  balanceSeries,
  buildLedger,
  fullCsv,
  monthly,
  quickbooksCsv,
  runwayMonths,
  unrealizedGainUsd,
  xeroCsv,
  type ChainTx,
  type DailyPrice,
  type LedgerEntry,
} from "@/lib/ledger";
import {
  formatTaz,
  ofType,
  saveRecord,
  type AuditEvent,
  type LedgerNote,
  type PeriodClose,
  type Stored,
} from "@/lib/records";
import { healthScore } from "@/lib/health";
import { createPortal } from "@/lib/portal";
import type { Session } from "@/lib/session";

interface ChainData {
  txs: Map<string, ChainTx[]>;
  payments: Map<string, Payment[]>;
  balances: Map<string, Balance>;
  prices: Map<string, DailyPrice>;
  quote: RateQuote | null;
  isAdmin: boolean;
}

const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toLocaleString(undefined, { style: "currency", currency: "USD" });

function download(name: string, body: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function Books({
  session,
  accounts,
  records,
  onChanged,
}: {
  session: Session;
  accounts: string[];
  records: Stored[];
  onChanged: () => void;
}) {
  const [data, setData] = useState<ChainData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState<string>("all");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [printing, setPrinting] = useState(false);

  // Chain facts and bulk prices; everything else is computed here, in the browser.
  useEffect(() => {
    let cancelled = false;
    const t = session.token;
    Promise.all([
      Promise.all(accounts.map((a) => api<ChainTx[]>(`/v1/accounts/${a}/transactions`, { token: t }))),
      Promise.all(accounts.map((a) => api<Payment[]>(`/v1/accounts/${a}/payments`, { token: t }))),
      Promise.all(accounts.map((a) => api<Balance>(`/v1/accounts/${a}/balance`, { token: t }))),
      api<{ days: DailyPrice[] }>("/v1/rates/zec-usd/daily", { token: t }),
      api<RateQuote>("/v1/rates/zec-usd", { token: t }).catch(() => null),
      api<MembersResponse>("/v1/members", { token: t }).catch(() => null),
    ]).then(
      ([txs, pays, bals, daily, quote, members]) => {
        if (cancelled) return;
        setData({
          txs: new Map(accounts.map((a, i) => [a, txs[i]])),
          payments: new Map(accounts.map((a, i) => [a, pays[i]])),
          balances: new Map(accounts.map((a, i) => [a, bals[i]])),
          prices: new Map(daily.days.map((d) => [d.date, d])),
          quote,
          isAdmin: members?.members.find((m) => m.is_me)?.role === "admin",
        });
      },
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [accounts, session.token]);

  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    const t = setTimeout(() => window.print(), 50);
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", done);
    };
  }, [printing]);

  const notes = ofType(records, "ledger-note");
  const rules = ofType(records, "rule");
  const closes = ofType(records, "period-close");
  const audit = ofType(records, "audit");
  const closedMonths = new Set(closes.map((c) => c.value.month));

  const ledger = useMemo(() => {
    if (!data) return null;
    const labels = ofType(records, "account");
    const runs = ofType(records, "run");
    const contributors = ofType(records, "contributor");
    const payrollByTxid = new Map<string, { period: string; ref: string; kind?: "payroll" | "kudos" }>();
    const sentPayments: { id: string; txid: string; accountId: string; status: string }[] = [];
    for (const [accountId, ps] of data.payments) {
      for (const p of ps) {
        if (!p.txid) continue;
        sentPayments.push({ id: p.id, txid: p.txid, accountId, status: p.status });
        const run = runs.find((r) => r.value.paymentId === p.id);
        if (run) payrollByTxid.set(p.txid, { period: run.value.period, ref: run.value.ref, kind: run.value.kind });
      }
    }
    const chainTip = Math.max(0, ...[...data.balances.values()].map((b) => b.chain_tip));
    return buildLedger({
      accounts: accounts.map((id) => ({
        id,
        name: labels.find((l) => l.value.accountId === id)?.value.name ?? "Account",
        txs: data.txs.get(id) ?? [],
      })),
      contributorsByAddress: new Map(contributors.filter((c) => c.value.address).map((c) => [c.value.address, c.value.name])),
      payrollByTxid,
      sentPayments,
      notes: new Map(notes.map((n) => [n.value.txid, { category: n.value.category, note: n.value.note }])),
      rules: rules.map((r) => r.value),
      prices: data.prices,
      chainTip,
    });
  }, [data, records, accounts, notes, rules]);

  if (error) return <p className="card text-sm text-danger">{error}</p>;
  if (!data || !ledger) return <p className="card text-sm text-muted">Building the books from your viewing keys…</p>;

  const all = ledger.entries;
  const months = [...new Set(all.map((e) => e.month).filter(Boolean) as string[])].sort().reverse();
  const shown = all.filter((e) => (month === "all" || e.month === month) && (!flaggedOnly || e.flags.length > 0));
  const rows = monthly(all);
  const walletTotal = [...data.balances.values()].reduce((s, b) => s + b.total_zats, 0);
  const series = balanceSeries(all);
  const ledgerTotal = series.at(-1)?.zats ?? 0;
  const rate = data.quote?.usd_per_zec ?? null;
  const balanceUsd = rate ? (walletTotal / 1e8) * rate : null;
  const runway = balanceUsd !== null ? runwayMonths(balanceUsd, rows) : null;
  const gain = rate ? unrealizedGainUsd(all, walletTotal, rate) : null;
  const flagged = all.filter((e) => e.flags.length > 0).length;
  const categories = [...DEFAULT_CATEGORIES];

  async function logAudit(action: string, detail: string) {
    await saveRecord(session, { type: "audit", at: new Date().toISOString(), by: session.memberId, action, detail } satisfies AuditEvent);
  }

  async function setCategory(e: LedgerEntry, category: string) {
    const existing = notes.find((n) => n.value.txid === e.txid);
    const value: LedgerNote = { type: "ledger-note", txid: e.txid, category, note: existing?.value.note };
    await saveRecord(session, value, existing?.id);
    await logAudit("categorize", `${e.txid.slice(0, 12)} ${e.category} → ${category}`);
    onChanged();
  }

  async function setNote(e: LedgerEntry) {
    const text = window.prompt("Note for this transaction (encrypted)", e.note ?? "");
    if (text === null) return;
    const existing = notes.find((n) => n.value.txid === e.txid);
    await saveRecord(session, { type: "ledger-note", txid: e.txid, category: existing?.value.category, note: text }, existing?.id);
    await logAudit("note", e.txid.slice(0, 12));
    onChanged();
  }

  async function closeMonth(m: string) {
    await saveRecord(session, { type: "period-close", month: m, closedAt: new Date().toISOString(), closedBy: session.memberId } satisfies PeriodClose);
    await logAudit("close-period", m);
    onChanged();
  }

  async function reopenMonth(m: string) {
    const c = closes.find((x) => x.value.month === m);
    if (!c) return;
    await api(`/v1/records/${c.id}`, { method: "DELETE", token: session.token });
    await logAudit("reopen-period", m);
    onChanged();
  }

  const scope = month === "all" ? "all" : month;
  const slice = (e: LedgerEntry) => scope === "all" || e.month === scope;

  return (
    <>
    <div className="space-y-5 print:hidden">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Balance", `${formatTaz(walletTotal)} TAZ`, balanceUsd !== null ? usd(balanceUsd) : "no rate"],
          ["Net this month", usd(rows[0]?.netUsd ?? 0), rows[0]?.month ?? "—"],
          ["Runway", runway ? `${runway.toFixed(1)} months` : "—", "at the last 3 months' burn"],
          ["Unrealized gain", usd(gain), "vs value when received (approx.)"],
        ].map(([k, v, sub]) => (
          <div key={k} className="card">
            <p className="label">{k}</p>
            <p className="text-xl font-semibold tabular-nums">{v}</p>
            <p className="text-xs text-muted">{sub}</p>
          </div>
        ))}
      </section>

      <HealthCard
        input={{
          ledgerMatchesChain: ledgerTotal === walletTotal,
          missingOnChain: ledger.missingOnChain.length,
          needsReview: flagged,
          sentPayments: [...data.payments.values()]
            .flat()
            .filter((p) => p.status === "broadcast" || p.status === "mined")
            .map((p) => ({ approvals: p.approvals.length })),
          runwayMonths: runway,
          lastMonthClosed: closedMonths.has(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7)),
          auditSharedThisQuarter: ofType(records, "audit-share").some(
            (s) => Math.floor(new Date(s.value.createdAt).getUTCMonth() / 3) === Math.floor(new Date().getUTCMonth() / 3) &&
              new Date(s.value.createdAt).getUTCFullYear() === new Date().getUTCFullYear(),
          ),
        }}
      />

      <section className="card">
        <h2 className="text-lg font-semibold">Reconciliation</h2>
        <ul className="mt-2 space-y-1 text-sm">
          <li className={ledgerTotal === walletTotal ? "text-ok" : "text-danger"}>
            {ledgerTotal === walletTotal ? "✓" : "✗"} Ledger balance {formatTaz(ledgerTotal)} TAZ{" "}
            {ledgerTotal === walletTotal ? "matches" : "does not match"} the chain ({formatTaz(walletTotal)} TAZ)
            {ledgerTotal !== walletTotal && " — unconfirmed transactions may still be settling"}
          </li>
          <li className={ledger.missingOnChain.length ? "text-danger" : "text-ok"}>
            {ledger.missingOnChain.length ? "✗" : "✓"} {ledger.missingOnChain.length} sent payment
            {ledger.missingOnChain.length === 1 ? "" : "s"} missing on chain
          </li>
          <li className={flagged ? "text-accent-ink" : "text-ok"}>
            {flagged ? "!" : "✓"} {flagged} entr{flagged === 1 ? "y needs" : "ies need"} review
          </li>
          {ledger.expired.length > 0 && (
            <li className="text-muted">
              {ledger.expired.length} built transaction{ledger.expired.length === 1 ? "" : "s"} expired unmined (excluded)
            </li>
          )}
        </ul>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Ledger</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select className="input w-auto" value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="all">All months</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {closedMonths.has(m) ? " (closed)" : ""}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-muted">
              <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} />
              Needs review
            </label>
          </div>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="pr-3 font-medium">Counterparty</th>
                <th className="pr-3 font-medium">Category</th>
                <th className="pr-3 text-right font-medium">TAZ</th>
                <th className="pr-3 text-right font-medium">USD</th>
                <th className="font-medium">Review</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map((e) => {
                const locked = !!e.month && closedMonths.has(e.month);
                const sign = e.direction === "in" ? "+" : "−";
                return (
                  <tr key={`${e.txid}-${e.accountId}`} className="align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {e.date ?? "pending"}
                      <span className="block text-xs text-muted">{e.accountName}</span>
                    </td>
                    <td className="pr-3">
                      {e.counterparty}
                      {e.memo && <span className="block max-w-xs truncate text-xs text-muted">“{e.memo}”</span>}
                      {e.note && <span className="block text-xs">Note: {e.note}</span>}
                    </td>
                    <td className="pr-3">
                      <select
                        className="input w-auto py-1 text-xs"
                        value={e.category}
                        disabled={locked || e.categorySource === "payroll"}
                        title={locked ? "Month is closed" : undefined}
                        onChange={(ev) => setCategory(e, ev.target.value)}
                      >
                        {[...new Set([...categories, e.category])].map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </td>
                    <td className="pr-3 text-right tabular-nums whitespace-nowrap">
                      {e.direction === "transfer" ? "" : sign}
                      {formatTaz(e.amountZats)}
                      {e.feeZats > 0 && <span className="block text-xs text-muted">fee {formatTaz(e.feeZats)}</span>}
                    </td>
                    <td className="pr-3 text-right tabular-nums whitespace-nowrap">
                      {usd(e.usdValue)}
                      {e.usdPerZec && <span className="block text-xs text-muted">@ {usd(e.usdPerZec)}</span>}
                    </td>
                    <td className="text-xs">
                      {e.flags.map((f) => (
                        <span key={f} className="block text-accent-ink">
                          {f}
                        </span>
                      ))}
                      {!locked && (
                        <button className="text-muted hover:text-foreground" onClick={() => setNote(e)}>
                          {e.note ? "Edit note" : "Add note"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card">
          <h2 className="text-lg font-semibold">Treasury balance</h2>
          <div className="mt-3">
            <BalanceChart series={series} />
          </div>
        </section>
        <Rules session={session} rules={rules} categories={categories} onChanged={onChanged} />
      </div>

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Monthly report</h2>
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost px-3 py-1 text-xs" onClick={() => download(`zebfin-quickbooks-${scope}.csv`, quickbooksCsv(all.filter(slice)))}>
              QuickBooks CSV
            </button>
            <button className="btn-ghost px-3 py-1 text-xs" onClick={() => download(`zebfin-xero-${scope}.csv`, xeroCsv(all.filter(slice)))}>
              Xero CSV
            </button>
            <button className="btn-ghost px-3 py-1 text-xs" onClick={() => download(`zebfin-ledger-${scope}.csv`, fullCsv(all.filter(slice)))}>
              Full ledger CSV
            </button>
            <button className="btn-ghost px-3 py-1 text-xs" onClick={() => setPrinting(true)}>
              Period report (PDF)
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted">
          Exports are generated in your browser. USD uses daily closing prices on each transaction&apos;s date. This is
          data for your accountant, not tax advice.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 font-medium">Month</th>
                <th className="text-right font-medium">Income</th>
                <th className="text-right font-medium">Payroll</th>
                <th className="text-right font-medium">Other spend</th>
                <th className="text-right font-medium">Fees</th>
                <th className="text-right font-medium">Net</th>
                <th className="text-right font-medium">Period</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border tabular-nums">
              {rows.map((r) => (
                <tr key={r.month}>
                  <td className="py-2">{r.month}</td>
                  <td className="text-right">{usd(r.incomeUsd)}</td>
                  <td className="text-right">{usd(r.payrollUsd)}</td>
                  <td className="text-right">{usd(r.otherSpendUsd)}</td>
                  <td className="text-right">{usd(r.feesUsd)}</td>
                  <td className="text-right font-medium">{usd(r.netUsd)}</td>
                  <td className="text-right">
                    {closedMonths.has(r.month) ? (
                      data.isAdmin ? (
                        <button className="text-xs text-muted hover:text-foreground" onClick={() => reopenMonth(r.month)}>
                          Closed · reopen
                        </button>
                      ) : (
                        <span className="text-xs text-muted">Closed</span>
                      )
                    ) : (
                      <button className="text-xs text-accent-ink hover:underline" onClick={() => closeMonth(r.month)}>
                        Close month
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <AuditorShare
        session={session}
        accounts={accounts.map((id) => ({ id, name: ofType(records, "account").find((l) => l.value.accountId === id)?.value.name ?? "Account" }))}
        entries={all}
        months={months}
        isAdmin={data.isAdmin}
        shares={ofType(records, "audit-share")}
        onChanged={onChanged}
      />

      {audit.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-semibold">Audit trail ({audit.length})</summary>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {[...audit]
              .sort((a, b) => b.value.at.localeCompare(a.value.at))
              .map((a) => (
                <li key={a.id}>
                  {new Date(a.value.at).toLocaleString()} · {a.value.action} · {a.value.detail}
                  {a.value.by === session.memberId && " · you"}
                </li>
              ))}
          </ul>
        </details>
      )}

    </div>
    {printing && <PeriodReport orgName={session.orgName} scope={scope} entries={all.filter(slice)} />}
    </>
  );
}

function Rules({
  session,
  rules,
  categories,
  onChanged,
}: {
  session: Session;
  rules: Stored<import("@/lib/records").LedgerRule>[];
  categories: string[];
  onChanged: () => void;
}) {
  const [match, setMatch] = useState<"memo" | "address">("memo");
  const [value, setValue] = useState("");
  const [category, setCategory] = useState("Software");

  return (
    <section className="card">
      <h2 className="text-lg font-semibold">Categorization rules</h2>
      <p className="mt-1 text-xs text-muted">Encrypted like everything else; applied in your browser.</p>
      <ul className="mt-3 space-y-1 text-sm">
        {rules.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2">
            <span>
              {r.value.match === "memo" ? "Memo contains" : "Paid to"} <span className="mono">“{r.value.value.slice(0, 32)}”</span> →{" "}
              {r.value.category}
            </span>
            <button
              className="text-xs text-muted hover:text-danger"
              onClick={async () => {
                await api(`/v1/records/${r.id}`, { method: "DELETE", token: session.token });
                onChanged();
              }}
            >
              Remove
            </button>
          </li>
        ))}
        {rules.length === 0 && <li className="text-muted">No rules yet.</li>}
      </ul>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          await saveRecord(session, { type: "rule", match, value: value.trim(), category });
          setValue("");
          onChanged();
        }}
      >
        <select className="input w-auto" value={match} onChange={(e) => setMatch(e.target.value as "memo" | "address")}>
          <option value="memo">Memo contains</option>
          <option value="address">Paid to address</option>
        </select>
        <input className="input w-40 flex-1" value={value} onChange={(e) => setValue(e.target.value)} placeholder="hosting" required />
        <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <button className="btn px-3 py-1">Add</button>
      </form>
    </section>
  );
}

function PeriodReport({ orgName, scope, entries }: { orgName: string; scope: string; entries: LedgerEntry[] }) {
  const rows = monthly(entries);
  return (
    <div className="fixed inset-0 hidden bg-white p-10 text-black print:block">
      <h1 className="text-2xl font-semibold">{orgName}: period report</h1>
      <p className="text-sm text-gray-600">
        {scope === "all" ? "All periods" : scope} · generated {new Date().toLocaleString()} · Zcash testnet
      </p>
      <table className="mt-6 w-full text-sm">
        <thead className="border-b text-left">
          <tr>
            <th className="py-1">Month</th>
            <th className="text-right">Income</th>
            <th className="text-right">Payroll</th>
            <th className="text-right">Other</th>
            <th className="text-right">Fees</th>
            <th className="text-right">Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className="border-b border-gray-200">
              <td className="py-1">{r.month}</td>
              <td className="text-right">{usd(r.incomeUsd)}</td>
              <td className="text-right">{usd(r.payrollUsd)}</td>
              <td className="text-right">{usd(r.otherSpendUsd)}</td>
              <td className="text-right">{usd(r.feesUsd)}</td>
              <td className="text-right">{usd(r.netUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="mt-8 font-semibold">Transactions</h2>
      <table className="mt-2 w-full text-xs">
        <tbody>
          {entries.map((e) => (
            <tr key={`${e.txid}-${e.accountId}`} className="border-b border-gray-200">
              <td className="py-1 pr-2">{e.date ?? "pending"}</td>
              <td className="pr-2">{e.category}</td>
              <td className="pr-2">{e.counterparty}</td>
              <td className="pr-2 text-right">{(e.amountZats / 1e8).toFixed(8)} TAZ</td>
              <td className="text-right">{usd(e.usdValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-6 text-xs text-gray-600">
        Built in the browser from the organization&apos;s viewing keys and encrypted records. USD at daily closing
        prices (two sources). Not tax advice.
      </p>
    </div>
  );
}

/**
 * Auditors get a read-only, expiring package for ONE account and period, not
 * the org key: they never see other accounts, contributors or settings.
 */
function AuditorShare({
  session,
  accounts,
  entries,
  months,
  isAdmin,
  shares,
  onChanged,
}: {
  session: Session;
  accounts: { id: string; name: string }[];
  entries: LedgerEntry[];
  months: string[];
  isAdmin: boolean;
  shares: Stored<import("@/lib/records").AuditShare>[];
  onChanged: () => void;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [scope, setScope] = useState("all");
  const [days, setDays] = useState(14);
  const [memos, setMemos] = useState(false);
  const [withKey, setWithKey] = useState(false);
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function share() {
    setBusy(true);
    setError(null);
    try {
      const account = accounts.find((a) => a.id === accountId)!;
      const scoped = entries.filter((e) => e.accountId === accountId && (scope === "all" || e.month === scope));
      const ufvk = withKey
        ? (await api<{ ufvk: string }>(`/v1/accounts/${accountId}/viewing-key`, { token: session.token })).ufvk
        : undefined;
      const { portalId, secret } = await createPortal(
        session,
        {
          kind: "audit",
          orgName: session.orgName,
          accountName: account.name,
          scope,
          generatedAt: new Date().toISOString(),
          rows: monthly(scoped),
          entries: scoped.map((e) => ({
            date: e.date,
            direction: e.direction,
            category: e.category,
            counterparty: e.counterparty,
            memo: memos ? e.memo : null,
            amountZats: e.amountZats,
            feeZats: e.feeZats,
            usdValue: e.usdValue,
            txid: e.txid,
          })),
          ufvk,
        },
        { kind: "audit", expiresInDays: days },
      );
      const link = `${window.location.origin}/audit#${portalId}.${secret}`;
      await saveRecord(session, {
        type: "audit-share",
        portalId,
        link,
        accountName: account.name,
        scope,
        includesViewingKey: withKey,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + days * 864e5).toISOString(),
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(s: Stored<import("@/lib/records").AuditShare>) {
    await api(`/v1/portals/${s.value.portalId}`, { method: "DELETE", token: session.token });
    await api(`/v1/records/${s.id}`, { method: "DELETE", token: session.token });
    onChanged();
  }

  return (
    <section className="card">
      <h2 className="text-lg font-semibold">Share with an auditor</h2>
      <p className="mt-1 text-sm text-muted">
        A read-only link to one account&apos;s books for one period, expiring automatically. The auditor doesn&apos;t join
        the org and never sees other accounts, contributors or settings.
      </p>
      {isAdmin ? (
        <div className="mt-3 space-y-2 text-sm">
          <div className="flex flex-wrap gap-2">
            <select className="input w-auto" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select className="input w-auto" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">All months</option>
              {months.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 14, 30, 90].map((d) => (
                <option key={d} value={d}>
                  Expires in {d} days
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={memos} onChange={(e) => setMemos(e.target.checked)} />
            Include memos (payslips name people and amounts)
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={withKey} onChange={(e) => setWithKey(e.target.checked)} className="mt-1" />
            <span>
              Include this account&apos;s viewing key, so the auditor can verify against the chain.{" "}
              <span className="text-danger">
                A viewing key can&apos;t be revoked: it shows the account&apos;s full history forever. To end access later,
                move funds to a fresh account.
              </span>
            </span>
          </label>
          <button className="btn" onClick={share} disabled={busy || !accountId}>
            {busy ? "Encrypting…" : "Create audit link"}
          </button>
          {error && <p className="text-danger">{error}</p>}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted">Only admins can share audit links.</p>
      )}
      {shares.length > 0 && (
        <ul className="mt-4 divide-y divide-border text-sm">
          {shares.map((s) => {
            const expired = Date.parse(s.value.expiresAt) < now;
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {s.value.accountName} · {s.value.scope}
                  {s.value.includesViewingKey && <span className="text-danger"> · viewing key shared</span>}
                  <span className="block text-xs text-muted">
                    {expired ? "expired" : `expires ${new Date(s.value.expiresAt).toLocaleDateString()}`}
                  </span>
                </span>
                <span className="flex gap-2">
                  {!expired && (
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => navigator.clipboard.writeText(s.value.link)}>
                      Copy link
                    </button>
                  )}
                  {isAdmin && (
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => revoke(s)}>
                      Revoke
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function HealthCard({ input }: { input: import("@/lib/health").HealthInput }) {
  const { score, achievements } = healthScore(input);
  return (
    <section className="card">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <p className="label">Treasury health</p>
          <p className="text-4xl font-semibold tabular-nums">
            {score}
            <span className="text-base text-muted">/100</span>
          </p>
        </div>
        <ul className="grid flex-1 gap-1 text-sm sm:grid-cols-2">
          {achievements.map((a) => (
            <li key={a.id} className={a.earned ? "" : "text-muted"} title={a.hint}>
              {a.earned ? "✓" : "○"} {a.label} <span className="text-xs text-muted">+{a.weight}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
