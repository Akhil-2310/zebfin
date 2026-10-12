"use client";

import { PetIntro } from "@/components/PetIntro";
import { useEffect, useState } from "react";
import { openPortal, submitAddress, type ContributorPortal, type Payslip } from "@/lib/portal";
import { formatTaz } from "@/lib/records";
import { validateAddress } from "@/lib/signer";

export default function ContributePage() {
  const [portal, setPortal] = useState<ContributorPortal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState<Payslip | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    openPortal(window.location.hash).then(
      (p) => !cancelled && setPortal(p),
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(null);
    window.addEventListener("afterprint", done);
    const t = setTimeout(() => window.print(), 50);
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", done);
    };
  }, [printing]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const problem = await validateAddress(address);
      if (problem) throw new Error(problem);
      await submitAddress(window.location.hash, address.trim());
      setAddress("");
      setEditing(false);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !portal) {
    return (
      <main className="mx-auto w-full max-w-lg px-4 py-16">
        <PetIntro mood="sick" title="Can&apos;t open this portal" home={false}>
          <span className="text-danger">{error}</span>
        </PetIntro>
      </main>
    );
  }
  if (!portal) return <main className="mx-auto w-full max-w-lg px-4 py-16"><PetIntro mood="busy" title="Decrypting…" home={false} /></main>;

  const { card } = portal;
  return (
    <>
      <main className="mx-auto w-full max-w-2xl px-4 py-12 print:hidden">
        <PetIntro mood="happy" eyebrow="Contributor portal" title={`Hi ${card.contributorName}!`} home={false}>
          {card.orgName} pays you as <strong className="text-foreground">{card.role}</strong> in shielded ZEC on the
          Zcash testnet. Everything on this page is encrypted; only you and {card.orgName}&apos;s team can read it.
        </PetIntro>

        <section className="card mt-6">
          <h2 className="font-semibold">Payout address</h2>
          {portal.address && !editing ? (
            <>
              <p className="mono mt-2">{portal.address}</p>
              <button className="btn-ghost mt-3 px-3 py-1 text-xs" onClick={() => setEditing(true)}>
                Change address
              </button>
            </>
          ) : (
            <form onSubmit={onSubmit} className="mt-3 space-y-3">
              <p className="text-sm text-muted">
                Paste a <strong className="text-foreground">fresh</strong> shielded Unified Address from your wallet (for
                example Zodl or Zashi on testnet). Use one you don&apos;t give to anyone else, so payments to you can&apos;t
                be linked. Transparent addresses aren&apos;t accepted.
              </p>
              <textarea
                className="input mono h-24"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="utest1…"
                spellCheck={false}
              />
              <div className="flex gap-2">
                <button className="btn" disabled={busy || !address.trim()}>
                  {busy ? "Checking…" : "Save address"}
                </button>
                {editing && (
                  <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </section>

        <section className="card mt-5">
          <h2 className="font-semibold">Payslips</h2>
          {portal.payslips.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No payslips yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border text-sm">
              {portal.payslips.map((p) => (
                <li key={p.ref + p.issuedAt} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <p className="font-medium">{p.period}</p>
                    <p className="text-xs text-muted">
                      ref {p.ref} · issued {new Date(p.issuedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-right tabular-nums">
                      {formatTaz(p.amountZats)} TAZ
                      {p.grossUsd && <span className="block text-xs text-muted">${p.grossUsd.toFixed(2)} gross</span>}
                    </span>
                    <button className="btn-ghost px-3 py-1 text-xs" onClick={() => setPrinting(p)}>
                      PDF
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">
            Each payment also carries this payslip in its encrypted memo, readable only by your wallet.
          </p>
        </section>
      </main>

      {printing && <PrintableSlip slip={printing} />}
    </>
  );
}

function PrintableSlip({ slip }: { slip: Payslip }) {
  return (
    <div className="hidden bg-white p-10 font-sans text-black print:block">
      <h1 className="text-2xl font-semibold">Payslip</h1>
      <p className="mt-1 text-sm">{slip.orgName}</p>
      <table className="mt-6 w-full text-sm">
        <tbody>
          {[
            ["Contributor", slip.contributorName],
            ["Role", slip.role],
            ["Period", slip.period],
            ...(slip.grossUsd && slip.usdPerZec
              ? [
                  ["Gross pay", `$${slip.grossUsd.toFixed(2)} USD`],
                  ["Rate", `$${slip.usdPerZec.toFixed(2)} per ZEC (locked when the run was priced)`],
                ]
              : []),
            ["Amount paid", `${formatTaz(slip.amountZats)} TAZ (testnet)`],
            ["Reference", slip.ref],
            ["Issued", new Date(slip.issuedAt).toLocaleString()],
            ["Paid via", "Zcash shielded transaction (Ironwood pool)"],
          ].map(([k, v]) => (
            <tr key={k} className="border-b border-gray-200">
              <td className="py-2 pr-6 text-gray-600">{k}</td>
              <td className="py-2">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-6 text-xs text-gray-600">Memo: {slip.memo}</p>
      <p className="mt-2 text-xs text-gray-600">
        Generated in your browser from an encrypted record. Testnet funds have no monetary value.
      </p>
    </div>
  );
}
