"use client";

import { PetIntro } from "@/components/PetIntro";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { openInvoicePortal, submitAddress, type PayerPortal } from "@/lib/portal";
import { formatTaz } from "@/lib/records";
import { validateAddress } from "@/lib/signer";

export default function PayPage() {
  const [portal, setPortal] = useState<PayerPortal | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refund, setRefund] = useState("");
  const [saved, setSaved] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    openInvoicePortal(window.location.hash).then(
      async (p) => {
        if (cancelled) return;
        setPortal(p);
        setQr(await QRCode.toDataURL(p.card.uri, { margin: 1, width: 240 }));
      },
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (error && !portal) {
    return (
      <main className="mx-auto w-full max-w-lg px-4 py-16">
        <PetIntro mood="sick" title="Can&apos;t open this invoice" home={false}>
          <span className="text-danger">{error}</span>
        </PetIntro>
      </main>
    );
  }
  if (!portal) return <main className="mx-auto w-full max-w-lg px-4 py-16"><PetIntro mood="busy" title="Decrypting…" home={false} /></main>;
  const c = portal.card;
  const receipt = portal.receipts[0];

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-12">
      <PetIntro
        mood={receipt ? "party" : "hungry"}
        eyebrow="Invoice · Zcash testnet"
        title={
          <>
            {c.orgName} · {c.number}
          </>
        }
        home={false}
      >
        For {c.customer}: {c.description}. Due {c.dueDate}.
      </PetIntro>

      <section className="card mt-6">
        {receipt ? (
          <div>
            <p className="text-lg font-semibold text-ok">Paid · thank you</p>
            <p className="mt-1 text-sm text-muted">
              Receipt issued {new Date(receipt.issuedAt).toLocaleString()} for {formatTaz(receipt.paidZats)} TAZ.
            </p>
            <ul className="mono mt-2 text-muted">
              {receipt.txids.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qr && <img src={qr} alt="Payment request QR code" className="h-48 w-48 rounded bg-white p-1" />}
            <div className="min-w-0 text-sm">
              <p className="text-2xl font-semibold tabular-nums">{formatTaz(c.zats)} TAZ</p>
              <p className="text-muted">
                ${c.usdAmount.toFixed(2)} at ${c.usdPerZec.toFixed(2)}/ZEC
              </p>
              <p className="mt-3 text-xs text-muted">
                Scan with a shielded Zcash wallet, or open the payment link. It fills in the amount and the invoice
                reference.
              </p>
              <a href={c.uri} className="btn mt-3">
                Open in wallet
              </a>
              <p className="mono mt-3 text-muted">{c.address}</p>
            </div>
          </div>
        )}
      </section>

      <section className="card mt-5 text-sm">
        <h2 className="font-semibold">Refund address (optional)</h2>
        <p className="mt-1 text-muted">
          Shielded payments don&apos;t reveal who sent them, so if a refund is ever needed we&apos;ll send it here. Only{" "}
          {c.orgName} can read it.
        </p>
        {portal.refundAddress && !saved ? (
          <p className="mono mt-2">{portal.refundAddress}</p>
        ) : (
          <form
            className="mt-2 flex flex-col gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              const problem = await validateAddress(refund);
              if (problem) return setError(problem);
              await submitAddress(window.location.hash, refund.trim());
              setSaved(true);
              setRefund("");
              setVersion((v) => v + 1);
            }}
          >
            <input className="input mono" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="utest1…" />
            <button className="btn self-start" disabled={!refund.trim()}>
              Save refund address
            </button>
          </form>
        )}
        {saved && <p className="mt-2 text-ok">Saved.</p>}
        {error && <p className="mt-2 text-danger">{error}</p>}
      </section>
    </main>
  );
}
