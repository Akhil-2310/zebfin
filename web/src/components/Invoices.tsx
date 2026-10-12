"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, post, type Payment, type RateQuote } from "@/lib/api";
import { matchInvoice, zip321Uri, type Invoice, type InvoiceMatch } from "@/lib/invoices";
import type { ChainTx } from "@/lib/ledger";
import { createPortal, payLink, postReceipt, readResponse } from "@/lib/portal";
import { ZATS_PER_TAZ, formatTaz, saveRecord, type Stored } from "@/lib/records";
import type { Session } from "@/lib/session";

const BADGE: Record<InvoiceMatch["status"], string> = {
  unpaid: "text-muted",
  "part-paid": "text-accent-ink",
  paid: "text-ok",
  overpaid: "text-accent-ink",
};

export function Invoices({
  session,
  accountId,
  invoices,
  onChanged,
}: {
  session: Session;
  accountId: string;
  invoices: Stored<Invoice>[];
  onChanged: () => void;
}) {
  const [txs, setTxs] = useState<ChainTx[]>([]);
  const [customer, setCustomer] = useState("");
  const [description, setDescription] = useState("");
  const [usd, setUsd] = useState("25.00");
  const [due, setDue] = useState(() => new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const mine = invoices.filter((i) => i.value.accountId === accountId).sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt));

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<ChainTx[]>(`/v1/accounts/${accountId}/transactions`, { token: session.token }).then(
        (t) => !cancelled && setTxs(t),
        () => {},
      );
    const first = setTimeout(load, 0);
    const t = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [accountId, session.token]);

  // Send each paid invoice's receipt to the payer's link, once.
  useEffect(() => {
    for (const inv of mine) {
      const m = matchInvoice(inv.value, txs);
      if ((m.status === "paid" || m.status === "overpaid") && !inv.value.receiptSentAt && m.payments.every((p) => p.height)) {
        const issuedAt = new Date().toISOString();
        postReceipt(session, inv.value.portalId, inv.value.portalSecret, {
          kind: "receipt",
          number: inv.value.number,
          paidZats: m.receivedZats,
          txids: m.payments.map((p) => p.txid),
          issuedAt,
        })
          .then(() => saveRecord(session, { ...inv.value, receiptSentAt: issuedAt }, inv.id))
          .then(onChanged, () => {});
      }
    }
  }, [mine, txs, session, onChanged]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const quote = await api<RateQuote>("/v1/rates/zec-usd", { token: session.token });
      const usdAmount = Number(usd);
      const zats = Math.round((usdAmount / quote.usd_per_zec) * ZATS_PER_TAZ);
      // A fresh address for this invoice alone: payers can't link it to others.
      const { address } = await post<{ address: string }>(`/v1/accounts/${accountId}/addresses`, {}, session.token);
      const number = `INV-${String(invoices.length + 1).padStart(4, "0")}`;
      const uri = zip321Uri(address, zats, `${session.orgName} ${number}`, `${session.orgName} invoice ${number}`);
      const { portalId, secret } = await createPortal(session, {
        kind: "invoice",
        orgName: session.orgName,
        number,
        customer: customer.trim(),
        description: description.trim(),
        usdAmount,
        usdPerZec: quote.usd_per_zec,
        zats,
        address,
        uri,
        dueDate: due,
      });
      const id = await saveRecord(session, {
        type: "invoice",
        number,
        customer: customer.trim(),
        description: description.trim(),
        usdAmount,
        usdPerZec: quote.usd_per_zec,
        zats,
        address,
        dueDate: due,
        createdAt: new Date().toISOString(),
        accountId,
        portalId,
        portalSecret: secret,
      });
      setOpen(id);
      setCustomer("");
      setDescription("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="text-lg font-semibold">Invoices</h2>
      <p className="mt-1 text-sm text-muted">
        Each invoice gets its own shielded address, so customers can&apos;t see what others paid. The customer gets a
        private link with the payment request and, once paid, an encrypted receipt.
      </p>

      <form onSubmit={create} className="mt-4 grid gap-2 sm:grid-cols-2">
        <input className="input" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Customer" required />
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What for" required />
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">$</span>
          <input className="input" value={usd} onChange={(e) => setUsd(e.target.value)} inputMode="decimal" required />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">Due</span>
          <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} required />
        </div>
        <button className="btn sm:col-span-2" disabled={busy}>
          {busy ? "Creating…" : "Create invoice"}
        </button>
        {error && <p className="text-sm text-danger sm:col-span-2">{error}</p>}
      </form>

      {mine.length > 0 && (
        <ul className="mt-5 divide-y divide-border text-sm">
          {mine.map((inv) => {
            const m = matchInvoice(inv.value, txs);
            return (
              <li key={inv.id} className="py-2">
                <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen(open === inv.id ? null : inv.id)}>
                  <span>
                    <span className="font-medium">{inv.value.number}</span> · {inv.value.customer}
                    <span className="block text-xs text-muted">{inv.value.description}</span>
                  </span>
                  <span className="text-right">
                    <span className="tabular-nums">${inv.value.usdAmount.toFixed(2)}</span>
                    <span className={`block text-xs ${BADGE[m.status]}`}>
                      {m.status}
                      {m.status === "part-paid" && ` (${formatTaz(m.receivedZats)} of ${formatTaz(inv.value.zats)})`}
                      {inv.value.receiptSentAt && " · receipt sent"}
                    </span>
                  </span>
                </button>
                {open === inv.id && <InvoiceDetail session={session} invoice={inv} match={m} onChanged={onChanged} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function InvoiceDetail({
  session,
  invoice,
  match,
  onChanged,
}: {
  session: Session;
  invoice: Stored<Invoice>;
  match: InvoiceMatch;
  onChanged: () => void;
}) {
  const inv = invoice.value;
  const [qr, setQr] = useState<string | null>(null);
  const [refundTo, setRefundTo] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const uri = zip321Uri(inv.address, inv.zats, `${session.orgName} ${inv.number}`, `${session.orgName} invoice ${inv.number}`);
  const link = payLink(inv.portalId, inv.portalSecret);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(uri, { margin: 1, width: 200 }).then((d) => !cancelled && setQr(d));
    readResponse(session, inv.portalId, inv.portalSecret).then((r) => !cancelled && setRefundTo(r?.address ?? null), () => {});
    return () => {
      cancelled = true;
    };
  }, [uri, session, inv.portalId, inv.portalSecret]);

  const excess = Math.max(0, match.receivedZats - inv.zats);
  async function refund(zats: number) {
    setMsg(null);
    try {
      const p = await post<Payment>(
        `/v1/accounts/${inv.accountId}/payments`,
        { kind: "refund", recipients: [{ address: refundTo, value_zats: zats, memo: `Refund for ${session.orgName} ${inv.number}` }] },
        session.token,
      );
      await saveRecord(session, { ...inv, refundPaymentId: p.id }, invoice.id);
      await saveRecord(session, { type: "request-note", paymentId: p.id, reason: `Refund ${inv.number}`, payeeLabel: inv.customer });
      setMsg("Refund requested: it needs approvals in Payments before it's sent.");
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-4 well p-3 sm:flex-row">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {qr && <img src={qr} alt={`Payment QR for ${inv.number}`} className="h-36 w-36 rounded bg-white p-1" />}
      <div className="min-w-0 space-y-2 text-xs">
        <p>
          {formatTaz(inv.zats)} TAZ at ${inv.usdPerZec.toFixed(2)}/ZEC · due {inv.dueDate}
        </p>
        <p className="mono text-muted">{uri.slice(0, 90)}…</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => navigator.clipboard.writeText(link)}>
            Copy customer link
          </button>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => navigator.clipboard.writeText(uri)}>
            Copy payment URI
          </button>
        </div>
        {match.payments.length > 0 && (
          <ul className="text-muted">
            {match.payments.map((p) => (
              <li key={p.txid}>
                +{formatTaz(p.zats)} TAZ · {p.height ? `block ${p.height}` : "unconfirmed"} · {p.txid.slice(0, 12)}…
              </li>
            ))}
          </ul>
        )}
        {inv.refundPaymentId ? (
          <p className="text-muted">Refund requested.</p>
        ) : match.receivedZats > 0 && refundTo ? (
          <div className="flex flex-wrap gap-2">
            {excess > 0 && (
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => refund(excess)}>
                Refund overpayment ({formatTaz(excess)} TAZ)
              </button>
            )}
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => refund(match.receivedZats)}>
              Refund in full
            </button>
          </div>
        ) : match.receivedZats > 0 ? (
          <p className="text-muted">To refund, the customer can add a refund address on their invoice link (shielded payments have no visible sender).</p>
        ) : null}
        {msg && <p>{msg}</p>}
      </div>
    </div>
  );
}
