// Sealed-bid auctions with on-chain commit-reveal.
//
// Bond memo:   ZBID1|<auction>|<commitment hex>|<refund address>
// Reveal memo: ZREV1|<auction>|<commitment hex>|<bid cents>|<salt hex>
//
// commitment = SHA-256("zebfin/bid/v1|" auction "|" bid "|" salt "|" refund)
// The bond carries no bid value, so nobody (organizer included) can read a
// bid before bidders reveal after the deadline. Everything is in shielded
// memos to the auction's own account, so anyone given that account's viewing
// key can re-check the result.

import { sha256 } from "@noble/hashes/sha2";
import type { ChainTx } from "./ledger";

export type AuctionKind = "procurement" | "sale";
export type Pricing = "first-price" | "second-price";

export interface AuctionRules {
  auctionId: string;
  title: string;
  description: string;
  kind: AuctionKind;
  pricing: Pricing;
  bondZats: number;
  /** Bonds must be mined at or before this time (ISO). */
  biddingEndsAt: string;
  /** Reveals must be mined after biddingEndsAt and at or before this time. */
  revealEndsAt: string;
  address: string;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Short, memo-friendly auction tag. */
export const auctionTag = (auctionId: string) => auctionId.replace(/-/g, "").slice(0, 12);

export function commitment(auctionId: string, bidCents: number, saltHex: string, refundAddress: string): string {
  const msg = `zebfin/bid/v1|${auctionTag(auctionId)}|${bidCents}|${saltHex}|${refundAddress.trim()}`;
  return hex(sha256(new TextEncoder().encode(msg)));
}

export const bondMemo = (auctionId: string, commit: string, refund: string) => `ZBID1|${auctionTag(auctionId)}|${commit}|${refund.trim()}`;
export const revealMemo = (auctionId: string, commit: string, bidCents: number, saltHex: string) =>
  `ZREV1|${auctionTag(auctionId)}|${commit}|${bidCents}|${saltHex}`;

export interface BidReceipt {
  auctionId: string;
  bidCents: number;
  saltHex: string;
  refundAddress: string;
  commitment: string;
}

export function newBid(auctionId: string, bidCents: number, refundAddress: string, salt: Uint8Array): BidReceipt {
  const saltHex = hex(salt);
  return { auctionId, bidCents, saltHex, refundAddress: refundAddress.trim(), commitment: commitment(auctionId, bidCents, saltHex, refundAddress) };
}

export interface Bid {
  commitment: string;
  refundAddress: string;
  bondZats: number;
  bondTxid: string;
  bondAt: number | null;
  /** Bond met the rules: right amount, mined by the deadline, first use of this commitment. */
  bondValid: boolean;
  bondProblem?: string;
  revealed?: { bidCents: number; saltHex: string; txid: string; at: number | null; valid: boolean; problem?: string };
}

/** Reads bonds and reveals from the auction account's transactions. */
export function parseBids(rules: AuctionRules, txs: ChainTx[]): Bid[] {
  const tag = auctionTag(rules.auctionId);
  const biddingEnd = Date.parse(rules.biddingEndsAt) / 1000;
  const revealEnd = Date.parse(rules.revealEndsAt) / 1000;
  const bids = new Map<string, Bid>();
  const outputs = txs
    .flatMap((tx) => tx.outputs.filter((o) => o.direction === "received" && o.memo).map((o) => ({ tx, o })))
    .sort((a, b) => (a.tx.block_time ?? Infinity) - (b.tx.block_time ?? Infinity));

  for (const { tx, o } of outputs) {
    const parts = o.memo!.split("|");
    if (parts[0] === "ZBID1" && parts[1] === tag && parts.length === 4) {
      const [, , commit, refund] = parts;
      if (bids.has(commit)) continue; // duplicate commitment: first one counts
      let problem: string | undefined;
      if (o.value_zats !== rules.bondZats) problem = "wrong bond amount";
      else if (!tx.block_time) problem = "not yet mined";
      else if (tx.block_time > biddingEnd) problem = "arrived after the bidding deadline";
      bids.set(commit, {
        commitment: commit,
        refundAddress: refund,
        bondZats: o.value_zats,
        bondTxid: tx.txid,
        bondAt: tx.block_time,
        bondValid: !problem,
        bondProblem: problem,
      });
    }
  }
  for (const { tx, o } of outputs) {
    const parts = o.memo!.split("|");
    if (parts[0] !== "ZREV1" || parts[1] !== tag || parts.length !== 5) continue;
    const [, , commit, centsStr, saltHex] = parts;
    const bid = bids.get(commit);
    if (!bid || bid.revealed?.valid) continue;
    const bidCents = Number(centsStr);
    let problem: string | undefined;
    if (!Number.isInteger(bidCents) || bidCents <= 0) problem = "malformed bid";
    else if (commitment(rules.auctionId, bidCents, saltHex, bid.refundAddress) !== commit) problem = "doesn't match the commitment";
    else if (!tx.block_time) problem = "not yet mined";
    else if (tx.block_time <= biddingEnd) problem = "revealed before bidding closed";
    else if (tx.block_time > revealEnd) problem = "revealed after the reveal deadline";
    bid.revealed = { bidCents, saltHex, txid: tx.txid, at: tx.block_time, valid: !problem, problem };
  }
  return [...bids.values()];
}

export interface Outcome {
  winner: Bid | null;
  /** What the winner pays (sale) or is paid (procurement), in cents. */
  priceCents: number | null;
  ranked: Bid[];
  /** Valid bonds to refund: everyone who revealed validly except the winner, plus late bonds. */
  refunds: Bid[];
  /** Valid bonds that were never validly revealed: forfeited. */
  forfeited: Bid[];
}

export function decide(rules: AuctionRules, bids: Bid[]): Outcome {
  const qualified = bids.filter((b) => b.bondValid && b.revealed?.valid);
  // Procurement: lowest price wins. Sale: highest. Ties go to the earlier bond.
  const ranked = [...qualified].sort((a, b) => {
    const d = rules.kind === "procurement" ? a.revealed!.bidCents - b.revealed!.bidCents : b.revealed!.bidCents - a.revealed!.bidCents;
    return d || (a.bondAt ?? 0) - (b.bondAt ?? 0);
  });
  const winner = ranked[0] ?? null;
  const priceCents = !winner
    ? null
    : rules.pricing === "second-price" && ranked[1]
      ? ranked[1].revealed!.bidCents
      : winner.revealed!.bidCents;
  const late = bids.filter((b) => !b.bondValid && b.bondProblem === "arrived after the bidding deadline" && b.bondZats === rules.bondZats);
  return {
    winner,
    priceCents,
    ranked,
    refunds: [...ranked.slice(1), ...late],
    forfeited: bids.filter((b) => b.bondValid && !b.revealed?.valid),
  };
}

export type Phase = "bidding" | "revealing" | "closable";
export function phase(rules: AuctionRules, now = Date.now()): Phase {
  if (now <= Date.parse(rules.biddingEndsAt)) return "bidding";
  if (now <= Date.parse(rules.revealEndsAt)) return "revealing";
  return "closable";
}

/** Published results; bidders recompute every commitment themselves. */
export interface AuctionResults {
  kind: "auction-results";
  closedAt: string;
  winnerCommitment: string | null;
  priceCents: number | null;
  reveals: { commitment: string; bidCents: number; saltHex: string; refundAddress: string }[];
  forfeited: string[];
  refundPaymentId: string | null;
  viewingKey?: string;
}

/** Checks each published reveal against its commitment, as any bidder can. */
export function verifyResults(auctionId: string, results: AuctionResults): boolean {
  return results.reveals.every((r) => commitment(auctionId, r.bidCents, r.saltHex, r.refundAddress) === r.commitment);
}
