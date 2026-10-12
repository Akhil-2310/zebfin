// Offline tests for sealed-bid auction logic. Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bondMemo,
  commitment,
  decide,
  newBid,
  parseBids,
  phase,
  revealMemo,
  verifyResults,
  type AuctionRules,
} from "../src/lib/auction";
import type { ChainTx } from "../src/lib/ledger";

const AUCTION = "3f2b9c1e-0000-4000-8000-000000000001";
const t = (iso: string) => Date.parse(iso) / 1000;
const rules = (over: Partial<AuctionRules> = {}): AuctionRules => ({
  auctionId: AUCTION,
  title: "Logo design",
  description: "",
  kind: "procurement",
  pricing: "first-price",
  bondZats: 50_000,
  biddingEndsAt: "2026-10-20T12:00:00Z",
  revealEndsAt: "2026-10-21T12:00:00Z",
  address: "utest1auction",
  ...over,
});
const out = (txid: string, at: string | null, value: number, memo: string): ChainTx => ({
  txid,
  mined_height: at ? 100 : null,
  block_time: at ? t(at) : null,
  delta_zats: value,
  fee_zats: null,
  expired_unmined: false,
  outputs: [{ direction: "received", value_zats: value, is_change: false, memo, to_address: "utest1auction" }],
});
const salt = (n: number) => new Uint8Array(32).fill(n);

function scenario() {
  const a = newBid(AUCTION, 120_00, "utest1refundA", salt(1));
  const b = newBid(AUCTION, 95_00, "utest1refundB", salt(2));
  const c = newBid(AUCTION, 110_00, "utest1refundC", salt(3));
  const lazy = newBid(AUCTION, 50_00, "utest1refundD", salt(4)); // never reveals
  const late = newBid(AUCTION, 10_00, "utest1refundE", salt(5)); // bond after deadline
  const txs = [
    out("bondA", "2026-10-19T10:00:00Z", 50_000, bondMemo(AUCTION, a.commitment, a.refundAddress)),
    out("bondB", "2026-10-19T11:00:00Z", 50_000, bondMemo(AUCTION, b.commitment, b.refundAddress)),
    out("bondC", "2026-10-19T12:00:00Z", 50_000, bondMemo(AUCTION, c.commitment, c.refundAddress)),
    out("bondD", "2026-10-19T13:00:00Z", 50_000, bondMemo(AUCTION, lazy.commitment, lazy.refundAddress)),
    out("bondE", "2026-10-20T13:00:00Z", 50_000, bondMemo(AUCTION, late.commitment, late.refundAddress)),
    out("revA", "2026-10-20T15:00:00Z", 1000, revealMemo(AUCTION, a.commitment, a.bidCents, a.saltHex)),
    out("revB", "2026-10-20T16:00:00Z", 1000, revealMemo(AUCTION, b.commitment, b.bidCents, b.saltHex)),
    out("revC", "2026-10-20T17:00:00Z", 1000, revealMemo(AUCTION, c.commitment, c.bidCents, c.saltHex)),
  ];
  return { a, b, c, lazy, late, txs };
}

test("bond memos carry a commitment, not the bid, and fit in 512 bytes", () => {
  const bid = newBid(AUCTION, 123_45, "utest1" + "q".repeat(100), salt(9));
  const memo = bondMemo(AUCTION, bid.commitment, bid.refundAddress);
  assert.ok(!memo.includes("12345"));
  assert.ok(new TextEncoder().encode(memo).length <= 512);
  assert.ok(new TextEncoder().encode(revealMemo(AUCTION, bid.commitment, bid.bidCents, bid.saltHex)).length <= 512);
  assert.notEqual(commitment(AUCTION, 123_45, bid.saltHex, bid.refundAddress), commitment(AUCTION, 123_46, bid.saltHex, bid.refundAddress));
});

test("procurement first-price: lowest valid reveal wins; losers refunded; non-revealers forfeit", () => {
  const { b, c, a, lazy, late, txs } = scenario();
  const bids = parseBids(rules(), txs);
  const o = decide(rules(), bids);
  assert.equal(o.winner?.commitment, b.commitment);
  assert.equal(o.priceCents, 95_00);
  assert.deepEqual(o.ranked.map((x) => x.commitment), [b.commitment, c.commitment, a.commitment]);
  assert.deepEqual(new Set(o.refunds.map((x) => x.commitment)), new Set([a.commitment, c.commitment, late.commitment]));
  assert.deepEqual(o.forfeited.map((x) => x.commitment), [lazy.commitment]);
});

test("sale second-price: highest wins and pays the runner-up's bid", () => {
  const { a, txs } = scenario();
  const o = decide(rules({ kind: "sale", pricing: "second-price" }), parseBids(rules(), txs));
  assert.equal(o.winner?.commitment, a.commitment);
  assert.equal(o.priceCents, 110_00);
});

test("bad reveals are rejected: wrong bid, early reveal, wrong bond, other auctions", () => {
  const { a, txs } = scenario();
  const cheat = [...txs];
  cheat[5] = out("revA", "2026-10-20T15:00:00Z", 1000, revealMemo(AUCTION, a.commitment, 1_00, a.saltHex));
  assert.equal(parseBids(rules(), cheat).find((x) => x.commitment === a.commitment)!.revealed!.problem, "doesn't match the commitment");

  const early = [...txs];
  early[5] = out("revA", "2026-10-20T11:00:00Z", 1000, revealMemo(AUCTION, a.commitment, a.bidCents, a.saltHex));
  assert.equal(parseBids(rules(), early).find((x) => x.commitment === a.commitment)!.revealed!.problem, "revealed before bidding closed");

  const cheapBond = [out("x", "2026-10-19T10:00:00Z", 10_000, bondMemo(AUCTION, a.commitment, a.refundAddress))];
  assert.equal(parseBids(rules(), cheapBond)[0].bondProblem, "wrong bond amount");

  const other = [out("x", "2026-10-19T10:00:00Z", 50_000, bondMemo("aaaaaaaa-1111-4000-8000-000000000000", a.commitment, a.refundAddress))];
  assert.equal(parseBids(rules(), other).length, 0);
});

test("phases and published-result verification", () => {
  assert.equal(phase(rules(), Date.parse("2026-10-20T11:00:00Z")), "bidding");
  assert.equal(phase(rules(), Date.parse("2026-10-20T13:00:00Z")), "revealing");
  assert.equal(phase(rules(), Date.parse("2026-10-21T13:00:00Z")), "closable");
  const { b } = scenario();
  const results = {
    kind: "auction-results" as const,
    closedAt: "",
    winnerCommitment: b.commitment,
    priceCents: b.bidCents,
    reveals: [{ commitment: b.commitment, bidCents: b.bidCents, saltHex: b.saltHex, refundAddress: b.refundAddress }],
    forfeited: [],
    refundPaymentId: null,
  };
  assert.ok(verifyResults(AUCTION, results));
  assert.ok(!verifyResults(AUCTION, { ...results, reveals: [{ ...results.reveals[0], bidCents: 1 }] }), "tampered result detected");
});
