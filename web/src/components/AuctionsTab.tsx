"use client";

import { useEffect, useState } from "react";
import { PaymentCard } from "@/components/PaymentCard";
import { createSiblingAccount } from "@/lib/accounts";
import { api, post, type MembersResponse, type Payment } from "@/lib/api";
import { decide, parseBids, phase, type AuctionKind, type AuctionResults, type AuctionRules, type Pricing } from "@/lib/auction";
import { newId } from "@/lib/crypto";
import type { ChainTx } from "@/lib/ledger";
import { createPortal, postAuctionResults } from "@/lib/portal";
import { ZATS_PER_TAZ, formatTaz, ofType, saveRecord, type AuctionRecord, type Stored } from "@/lib/records";
import type { Session } from "@/lib/session";
import { hasSigningKey } from "@/lib/signer";

const cents = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
const bidLink = (a: AuctionRecord) => `${window.location.origin}/bid#${a.portalId}.${a.portalSecret}`;

export function AuctionsTab({
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
  const auctions = ofType(records, "auction");
  const [open, setOpen] = useState<string | null>(auctions[0]?.id ?? null);
  const current = auctions.find((a) => a.id === open);

  return (
    <div className="grid gap-5 lg:grid-cols-[2fr_3fr]">
      <div className="space-y-5">
        <Create session={session} records={records} accounts={accounts} onCreated={(id) => (setOpen(id), onChanged())} />
        <section className="card">
          <h2 className="text-lg font-semibold">Auctions</h2>
          <ul className="mt-2 divide-y divide-border text-sm">
            {auctions.map((a) => (
              <li key={a.id}>
                <button className={`w-full py-2 text-left ${open === a.id ? "font-medium" : ""}`} onClick={() => setOpen(a.id)}>
                  {a.value.rules.title}
                  <span className="block text-xs text-muted">
                    {a.value.rules.kind} · {a.value.results ? "closed" : phase(a.value.rules)}
                  </span>
                </button>
              </li>
            ))}
            {auctions.length === 0 && <li className="py-2 text-muted">No auctions yet.</li>}
          </ul>
        </section>
      </div>
      {current && <Detail key={current.id} session={session} auction={current} records={records} onChanged={onChanged} />}
    </div>
  );
}

function Create({
  session,
  records,
  accounts,
  onCreated,
}: {
  session: Session;
  records: Stored[];
  accounts: string[];
  onCreated: (recordId: string) => void;
}) {
  const labels = ofType(records, "account");
  const [keyed, setKeyed] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<AuctionKind>("procurement");
  const [pricing, setPricing] = useState<Pricing>("first-price");
  const [bond, setBond] = useState("0.0005");
  const [ends, setEnds] = useState(() => new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 16));
  const [revealHours, setRevealHours] = useState("24");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(accounts.map(async (a) => ((await hasSigningKey(session, a)) ? a : null))).then((r) => {
      if (cancelled) return;
      const k = r.filter(Boolean) as string[];
      setKeyed(k);
      setFrom((f) => f || k[0] || "");
    });
    return () => {
      cancelled = true;
    };
  }, [accounts, session]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const auctionId = newId();
      // Its own account: sharing its viewing key later reveals nothing else.
      const accountId = await createSiblingAccount(session, from, `Auction: ${title.trim()}`, labels);
      const { address } = await post<{ address: string }>(`/v1/accounts/${accountId}/addresses`, {}, session.token);
      const biddingEndsAt = new Date(ends).toISOString();
      const rules: AuctionRules = {
        auctionId,
        title: title.trim(),
        description: description.trim(),
        kind,
        pricing,
        bondZats: Math.round(Number(bond) * ZATS_PER_TAZ),
        biddingEndsAt,
        revealEndsAt: new Date(Date.parse(biddingEndsAt) + Number(revealHours) * 3600_000).toISOString(),
        address,
      };
      const { portalId, secret } = await createPortal(session, { kind: "auction", orgName: session.orgName, rules }, { kind: "auction" });
      const id = await saveRecord(session, { type: "auction", rules, accountId, portalId, portalSecret: secret });
      setTitle("");
      setDescription("");
      onCreated(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="text-lg font-semibold">New sealed-bid auction</h2>
      <p className="mt-1 text-xs text-muted">
        Bids are committed on-chain with a fixed bond and revealed only after bidding closes, so nobody, including you,
        can read a bid early.
      </p>
      {keyed.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Needs an account whose key is in this browser (each auction gets its own account from that seed).</p>
      ) : (
        <form onSubmit={create} className="mt-3 space-y-2 text-sm">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (e.g. Logo design)" required />
          <textarea className="input h-16" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's being bought or sold" />
          <div className="grid grid-cols-2 gap-2">
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as AuctionKind)}>
              <option value="procurement">Procurement (lowest wins)</option>
              <option value="sale">Sale (highest wins)</option>
            </select>
            <select className="input" value={pricing} onChange={(e) => setPricing(e.target.value as Pricing)}>
              <option value="first-price">First-price</option>
              <option value="second-price">Second-price</option>
            </select>
            <label>
              <span className="label">Bond (TAZ, same for everyone)</span>
              <input className="input" value={bond} onChange={(e) => setBond(e.target.value)} />
            </label>
            <label>
              <span className="label">Reveal window (hours)</span>
              <input className="input" value={revealHours} onChange={(e) => setRevealHours(e.target.value)} />
            </label>
            <label className="col-span-2">
              <span className="label">Bidding closes</span>
              <input className="input" type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} />
            </label>
            {keyed.length > 1 && (
              <label className="col-span-2">
                <span className="label">Derive the auction account from</span>
                <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
                  {keyed.map((a) => (
                    <option key={a} value={a}>
                      {labels.find((l) => l.value.accountId === a)?.value.name ?? a.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <button className="btn" disabled={busy}>
            {busy ? "Creating account…" : "Create auction"}
          </button>
          {error && <p className="text-danger">{error}</p>}
        </form>
      )}
    </section>
  );
}

function Detail({
  session,
  auction,
  records,
  onChanged,
}: {
  session: Session;
  auction: Stored<AuctionRecord>;
  records: Stored[];
  onChanged: () => void;
}) {
  const a = auction.value;
  const r = a.rules;
  const [txs, setTxs] = useState<ChainTx[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [shareKey, setShareKey] = useState(false);
  const [refund, setRefund] = useState<Payment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<ChainTx[]>(`/v1/accounts/${a.accountId}/transactions`, { token: session.token }).then((t) => !cancelled && setTxs(t), () => {});
    const first = setTimeout(load, 0);
    const t = setInterval(load, 20_000);
    api<MembersResponse>("/v1/members", { token: session.token }).then(
      (m) => !cancelled && setIsAdmin(m.members.find((x) => x.is_me)?.role === "admin"),
      () => {},
    );
    if (a.results?.refundPaymentId)
      api<Payment>(`/v1/payments/${a.results.refundPaymentId}`, { token: session.token }).then((p) => !cancelled && setRefund(p), () => {});
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [a.accountId, a.results?.refundPaymentId, session.token]);

  const bids = parseBids(r, txs);
  const p = phase(r);
  const outcome = decide(r, bids);

  async function close() {
    setBusy(true);
    setError(null);
    try {
      let refundPaymentId: string | null = null;
      if (outcome.refunds.length) {
        const payment = await post<Payment>(
          `/v1/accounts/${a.accountId}/payments`,
          {
            kind: "refund",
            recipients: outcome.refunds.map((b) => ({
              address: b.refundAddress,
              value_zats: b.bondZats,
              memo: `Zebfin auction bond refund | ${r.title}`.slice(0, 500),
            })),
          },
          session.token,
        );
        refundPaymentId = payment.id;
        setRefund(payment);
      }
      const viewingKey = shareKey
        ? (await api<{ ufvk: string }>(`/v1/accounts/${a.accountId}/viewing-key`, { token: session.token })).ufvk
        : undefined;
      const results: AuctionResults = {
        kind: "auction-results",
        closedAt: new Date().toISOString(),
        winnerCommitment: outcome.winner?.commitment ?? null,
        priceCents: outcome.priceCents,
        reveals: outcome.ranked.map((b) => ({
          commitment: b.commitment,
          bidCents: b.revealed!.bidCents,
          saltHex: b.revealed!.saltHex,
          refundAddress: b.refundAddress,
        })),
        forfeited: outcome.forfeited.map((b) => b.commitment),
        refundPaymentId,
        viewingKey,
      };
      await postAuctionResults(session, a.portalId, a.portalSecret, results);
      await saveRecord(session, { ...a, results }, auction.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-4 text-sm">
      <div>
        <h2 className="text-lg font-semibold">{r.title}</h2>
        <p className="text-muted">{r.description}</p>
        <p className="mt-1 text-xs text-muted">
          {r.kind === "procurement" ? "Lowest" : "Highest"} bid wins · {r.pricing} · bond {formatTaz(r.bondZats)} TAZ · bidding
          closes {new Date(r.biddingEndsAt).toLocaleString()} · reveals until {new Date(r.revealEndsAt).toLocaleString()}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-border px-2 py-0.5 text-xs">{a.results ? "closed" : p}</span>
        <button className="btn-ghost px-3 py-1 text-xs" onClick={() => navigator.clipboard.writeText(bidLink(a))}>
          Copy bidder link
        </button>
        <span className="text-xs text-muted">Share privately with invited bidders, or publicly for an open auction.</span>
      </div>

      <div>
        <h3 className="font-semibold">Bids ({bids.length})</h3>
        <p className="text-xs text-muted">
          {p === "bidding" ? "Only commitments are visible until bidding closes." : "Reveals arrive after bidding closes."}
        </p>
        <table className="mt-2 w-full text-xs">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 font-medium">Commitment</th>
              <th className="font-medium">Bond</th>
              <th className="font-medium">Revealed bid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {bids.map((b) => (
              <tr key={b.commitment} className={outcome.winner?.commitment === b.commitment ? "font-medium" : ""}>
                <td className="mono py-1">{b.commitment.slice(0, 14)}…</td>
                <td className={b.bondValid ? "" : "text-danger"}>{b.bondValid ? "✓" : b.bondProblem}</td>
                <td className={b.revealed && !b.revealed.valid ? "text-danger" : ""}>
                  {b.revealed ? (b.revealed.valid ? cents(b.revealed.bidCents) : b.revealed.problem) : p === "bidding" ? "sealed" : "not revealed"}
                  {outcome.winner?.commitment === b.commitment && " · winner"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {a.results ? (
        <div className="well p-3">
          <p className="font-medium">
            Closed {new Date(a.results.closedAt).toLocaleString()} · winner {a.results.winnerCommitment?.slice(0, 14) ?? "none"}… at{" "}
            {cents(a.results.priceCents)}
          </p>
          <p className="text-xs text-muted">
            {a.results.reveals.length} revealed · {a.results.forfeited.length} forfeited · results published to bidders
            {a.results.viewingKey ? " with the auction account's viewing key" : ""}.
          </p>
        </div>
      ) : (
        p === "closable" && (
          <div className="space-y-2 well p-3">
            <p>
              {outcome.winner ? `Winner: ${outcome.winner.commitment.slice(0, 14)}… at ${cents(outcome.priceCents)}` : "No valid revealed bids."} ·{" "}
              {outcome.refunds.length} bond refund{outcome.refunds.length === 1 ? "" : "s"} · {outcome.forfeited.length} forfeited
            </p>
            {isAdmin && (
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={shareKey} onChange={(e) => setShareKey(e.target.checked)} className="mt-0.5" />
                Share this auction account&apos;s viewing key with bidders so they can verify every bond and reveal on-chain (it
                covers only this auction&apos;s account and can&apos;t be revoked).
              </label>
            )}
            <button className="btn" onClick={close} disabled={busy}>
              {busy ? "Closing…" : "Close auction, refund losing bonds, publish results"}
            </button>
          </div>
        )
      )}
      {refund && (
        <PaymentCard session={session} payment={refund} onUpdate={setRefund} memberLabels={ofType(records, "member")} title="Bond refunds" />
      )}
      {error && <p className="text-danger">{error}</p>}
    </section>
  );
}
