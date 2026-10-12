"use client";

import { PetIntro } from "@/components/PetIntro";
import { useEffect, useState } from "react";
import { openAuditPortal, type AuditCard } from "@/lib/portal";
import { formatTaz } from "@/lib/records";

const usd = (n: number | null) => (n === null ? "—" : n.toLocaleString(undefined, { style: "currency", currency: "USD" }));

function downloadCsv(card: AuditCard) {
  const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [
    ["date", "direction", "category", "counterparty", "amount_zec", "fee_zec", "usd_value", "memo", "txid"],
    ...card.entries.map((e) => [
      e.date ?? "",
      e.direction,
      e.category,
      e.counterparty,
      (e.amountZats / 1e8).toFixed(8),
      (e.feeZats / 1e8).toFixed(8),
      e.usdValue?.toFixed(2) ?? "",
      e.memo ?? "",
      e.txid,
    ]),
  ];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(cell).join(",")).join("\n") + "\n"], { type: "text/csv" }));
  a.download = `${card.orgName}-${card.accountName}-${card.scope}-audit.csv`.replace(/\s+/g, "-");
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function AuditPage() {
  const [data, setData] = useState<{ card: AuditCard; expiresAt: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    openAuditPortal(window.location.hash).then(
      (d) => !cancelled && setData(d),
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-lg px-4 py-16">
        <PetIntro mood="sick" title="Audit link unavailable" home={false}>
          <span className="text-danger">{error}</span>
        </PetIntro>
      </main>
    );
  }
  if (!data) return <main className="mx-auto w-full max-w-lg px-4 py-16"><PetIntro mood="busy" title="Decrypting…" home={false} /></main>;
  const c = data.card;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10">
      <PetIntro
        mood="content"
        eyebrow="Audit package · read-only · testnet"
        title={
          <>
            {c.orgName}: {c.accountName}
          </>
        }
        home={false}
      >
        <p>
          Period: {c.scope === "all" ? "all months" : c.scope} · prepared {new Date(c.generatedAt).toLocaleString()}
          {data.expiresAt && ` · this link expires ${new Date(data.expiresAt).toLocaleString()}`}
        </p>
        <p className="mt-1 text-xs">
          Scoped to one account. USD at daily closing prices (two sources) on each transaction&apos;s date.
        </p>
      </PetIntro>

      <section className="card mt-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Monthly summary</h2>
          <button className="btn-ghost px-3 py-1 text-xs" onClick={() => downloadCsv(c)}>
            Download CSV
          </button>
        </div>
        <table className="mt-3 w-full text-sm tabular-nums">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-1 font-medium">Month</th>
              <th className="text-right font-medium">Income</th>
              <th className="text-right font-medium">Payroll</th>
              <th className="text-right font-medium">Other</th>
              <th className="text-right font-medium">Fees</th>
              <th className="text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {c.rows.map((r) => (
              <tr key={r.month}>
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
      </section>

      <section className="card mt-5 overflow-x-auto">
        <h2 className="font-semibold">Transactions ({c.entries.length})</h2>
        <table className="mt-3 w-full min-w-[720px] text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-1 font-medium">Date</th>
              <th className="font-medium">Category</th>
              <th className="font-medium">Counterparty</th>
              <th className="text-right font-medium">TAZ</th>
              <th className="text-right font-medium">USD</th>
              <th className="font-medium">Txid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {c.entries.map((e) => (
              <tr key={e.txid} className="align-top">
                <td className="py-1 pr-2 whitespace-nowrap">{e.date ?? "pending"}</td>
                <td className="pr-2">{e.category}</td>
                <td className="pr-2">
                  {e.counterparty}
                  {e.memo && <span className="block text-xs text-muted">“{e.memo}”</span>}
                </td>
                <td className="pr-2 text-right tabular-nums">
                  {e.direction === "in" ? "+" : "−"}
                  {formatTaz(e.amountZats)}
                </td>
                <td className="pr-2 text-right tabular-nums">{usd(e.usdValue)}</td>
                <td className="mono text-muted">{e.txid.slice(0, 12)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {c.ufvk && (
        <section className="card mt-5">
          <h2 className="font-semibold">Viewing key for this account</h2>
          <p className="mt-1 text-sm text-muted">
            Import into a Zcash wallet (e.g. <code className="mono">zebfin wallet import</code>) to verify these
            transactions against the chain yourself. It reveals this account only, and can&apos;t spend.
          </p>
          <p className="mono mt-2 well p-2">{c.ufvk}</p>
        </section>
      )}
    </main>
  );
}
