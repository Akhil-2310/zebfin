"use client";

import { PetIntro } from "@/components/PetIntro";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { bondMemo, newBid, phase, revealMemo, verifyResults, type AuctionResults, type BidReceipt } from "@/lib/auction";
import { randomBytes } from "@/lib/crypto";
import { zip321Uri } from "@/lib/invoices";
import { openAuctionPortal, type AuctionCard } from "@/lib/portal";
import { formatTaz } from "@/lib/records";
import { validateAddress } from "@/lib/signer";

/** A tiny reveal payment; wallets often refuse zero-value requests. */
const REVEAL_ZATS = 1000;
const storeKey = (auctionId: string) => `zebfin.bid.${auctionId}`;

export default function BidPage() {
  const [data, setData] = useState<{ card: AuctionCard; results: AuctionResults | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bid, setBid] = useState("");
  const [refund, setRefund] = useState("");
  const [receipt, setReceipt] = useState<BidReceipt | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  // Read the clock after mount, not during prerendering.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    openAuctionPortal(window.location.hash).then(
      (d) => {
        if (cancelled) return;
        setNow(Date.now());
        setData(d);
        try {
          const saved = localStorage.getItem(storeKey(d.card.rules.auctionId));
          if (saved) setReceipt(JSON.parse(saved));
        } catch {}
      },
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const rules = data?.card.rules;
  const p = rules && now !== null ? phase(rules, now) : null;
  // What the bidder pays now: the bond while bidding is open, a tiny reveal after.
  const pay =
    rules && receipt
      ? p === "bidding"
        ? { address: rules.address, zats: rules.bondZats, memo: bondMemo(rules.auctionId, receipt.commitment, receipt.refundAddress), label: `Bond for ${rules.title}` }
        : { address: rules.address, zats: REVEAL_ZATS, memo: revealMemo(rules.auctionId, receipt.commitment, receipt.bidCents, receipt.saltHex), label: `Reveal for ${rules.title}` }
      : null;
  const uri = pay ? zip321Uri(pay.address, pay.zats, pay.memo, pay.label) : null;

  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    QRCode.toDataURL(uri, { margin: 1, width: 220 }).then((d) => !cancelled && setQr(d));
    return () => {
      cancelled = true;
    };
  }, [uri]);

  async function seal(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = await validateAddress(refund);
    if (problem) return setError(problem);
    const cents = Math.round(Number(bid) * 100);
    if (!(cents > 0)) return setError("Enter your bid in USD.");
    const r = newBid(rules!.auctionId, cents, refund, randomBytes(32));
    setReceipt(r);
    try {
      localStorage.setItem(storeKey(rules!.auctionId), JSON.stringify(r));
    } catch {}
  }

  function downloadReceipt() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }));
    a.download = `bid-${rules!.auctionId.slice(0, 8)}.json`;
    a.click();
  }

  if (error && !data) {
    return (
      <main className="mx-auto w-full max-w-lg px-4 py-16">
        <PetIntro mood="sick" title="Can&apos;t open this auction" home={false}>
          <span className="text-danger">{error}</span>
        </PetIntro>
      </main>
    );
  }
  if (!data || !rules || p === null) return <main className="mx-auto w-full max-w-lg px-4 py-16"><PetIntro mood="busy" title="Decrypting…" home={false} /></main>;
  const results = data.results;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12">
      <PetIntro
        mood={results ? "party" : "busy"}
        eyebrow="Sealed-bid auction · Zcash testnet"
        title={
          <>
            {data.card.orgName}: {rules.title}
          </>
        }
        home={false}
      >
        {rules.description}
      </PetIntro>

      <section className="card mt-6 text-sm">
        <h2 className="font-semibold">Rules</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          <li>
            {rules.kind === "procurement" ? "Lowest" : "Highest"} bid wins; the winner {rules.kind === "procurement" ? "is paid" : "pays"}{" "}
            {rules.pricing === "second-price" ? "the runner-up's bid" : "their own bid"}.
          </li>
          <li>Everyone posts the same bond of {formatTaz(rules.bondZats)} TAZ, so the bond says nothing about your bid.</li>
          <li>Your bond carries only a cryptographic commitment. Nobody, including the organizer, can read your bid before bidding closes.</li>
          <li>
            Bidding closes {new Date(rules.biddingEndsAt).toLocaleString()}. Reveal your bid after that, before{" "}
            {new Date(rules.revealEndsAt).toLocaleString()}. Bonds that are never revealed are forfeited.
          </li>
          <li>Losing bonds are refunded to your refund address in one shielded transaction.</li>
          <li>
            <strong className="text-foreground">Disclosure:</strong> to let bidders verify the result, revealed bids (including losing ones)
            are shared with all participants after close.
          </li>
        </ul>
      </section>

      {results ? (
        <Results auctionId={rules.auctionId} results={results} mine={receipt?.commitment} />
      ) : p === "bidding" ? (
        <section className="card mt-5 text-sm">
          <h2 className="font-semibold">Place a sealed bid</h2>
          {!receipt ? (
            <form onSubmit={seal} className="mt-3 space-y-2">
              <label className="block">
                <span className="label">Your bid (USD)</span>
                <input className="input" value={bid} onChange={(e) => setBid(e.target.value)} inputMode="decimal" />
              </label>
              <label className="block">
                <span className="label">Refund address (a fresh shielded address)</span>
                <input className="input mono" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="utest1…" />
              </label>
              <button className="btn">Seal my bid</button>
            </form>
          ) : (
            <BondStep receipt={receipt} qr={qr} uri={uri!} pay={pay!} onDownload={downloadReceipt} label={`Pay the ${formatTaz(rules.bondZats)} TAZ bond`} />
          )}
        </section>
      ) : (
        <section className="card mt-5 text-sm">
          <h2 className="font-semibold">{p === "revealing" ? "Reveal your bid" : "Reveals are closed"}</h2>
          {p === "revealing" &&
            (receipt ? (
              <BondStep receipt={receipt} qr={qr} uri={uri!} pay={pay!} onDownload={downloadReceipt} label={`Send the reveal (${formatTaz(REVEAL_ZATS)} TAZ)`} />
            ) : (
              <label className="mt-2 block">
                <span className="label">Load your saved bid file</span>
                <input
                  type="file"
                  accept="application/json"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) setReceipt(JSON.parse(await f.text()));
                  }}
                />
              </label>
            ))}
          {p === "closable" && <p className="mt-2 text-muted">Waiting for the organizer to close the auction.</p>}
        </section>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </main>
  );
}

function BondStep({
  receipt,
  qr,
  uri,
  pay,
  onDownload,
  label,
}: {
  receipt: BidReceipt;
  qr: string | null;
  uri: string;
  pay: { address: string; zats: number; memo: string };
  onDownload: () => void;
  label: string;
}) {
  return (
    <div className="mt-3 space-y-3">
      <p>
        Bid sealed: <span className="tabular-nums">${(receipt.bidCents / 100).toFixed(2)}</span> · commitment{" "}
        <span className="mono">{receipt.commitment.slice(0, 16)}…</span>
      </p>
      <p className="text-accent-ink">
        Save your bid file. You need it to reveal; without it your bond is forfeited.{" "}
        <button className="underline" onClick={onDownload}>
          Download bid file
        </button>
      </p>
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {qr && <img src={qr} alt="Payment request" className="h-44 w-44 rounded bg-white p-1" />}
        <div>
          <p className="font-medium">{label}</p>
          <p className="mt-1 text-xs text-muted">Scan with a shielded Zcash wallet, or open the link. It fills in the amount and memo.</p>
          <a className="btn mt-2" href={uri}>
            Open in wallet
          </a>
        </div>
      </div>
      {/* For wallets that can't scan or open payment links: enter these by hand. */}
      <details className="well p-3 text-xs">
        <summary className="cursor-pointer">Pay manually (address, amount and memo)</summary>
        <dl className="mt-2 space-y-2">
          {(
            [
              ["To", pay.address],
              ["Amount", `${formatTaz(pay.zats)} TAZ`],
              ["Memo (exactly)", pay.memo],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="label mb-0">{k}</dt>
              <dd className="flex items-start gap-2">
                <span className="mono flex-1">{v}</span>
                <button className="btn-ghost shrink-0 px-2 py-0.5 text-xs" onClick={() => navigator.clipboard.writeText(k === "Amount" ? String(pay.zats / 1e8) : v)}>
                  Copy
                </button>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

function Results({ auctionId, results, mine }: { auctionId: string; results: AuctionResults; mine?: string }) {
  const verified = verifyResults(auctionId, results);
  return (
    <section className="card mt-5 text-sm">
      <h2 className="font-semibold">Results</h2>
      <p className={`mt-1 ${verified ? "text-ok" : "text-danger"}`}>
        {verified ? "✓ Every revealed bid matches its on-chain commitment (checked in your browser)." : "✗ A revealed bid doesn't match its commitment."}
      </p>
      <p className="mt-2">
        Winner: <span className="mono">{results.winnerCommitment?.slice(0, 16) ?? "none"}…</span> at{" "}
        {results.priceCents != null ? `$${(results.priceCents / 100).toFixed(2)}` : "—"}
        {mine && mine === results.winnerCommitment && <strong className="text-ok"> · that&apos;s you</strong>}
      </p>
      <table className="mt-3 w-full text-xs">
        <tbody className="divide-y divide-border">
          {results.reveals.map((r) => (
            <tr key={r.commitment} className={r.commitment === mine ? "font-medium" : ""}>
              <td className="mono py-1">{r.commitment.slice(0, 16)}…</td>
              <td className="text-right tabular-nums">${(r.bidCents / 100).toFixed(2)}</td>
              <td className="pl-2 text-muted">{r.commitment === mine ? "you" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {results.forfeited.length > 0 && <p className="mt-2 text-xs text-muted">{results.forfeited.length} bond(s) forfeited (never revealed).</p>}
      {results.viewingKey && (
        <div className="mt-3">
          <p className="label">Auction account viewing key</p>
          <p className="text-xs text-muted">Import it into a Zcash wallet to check every bond, reveal and refund on-chain yourself. It covers only this auction&apos;s account.</p>
          <p className="mono mt-1 well p-2">{results.viewingKey}</p>
        </div>
      )}
    </section>
  );
}
