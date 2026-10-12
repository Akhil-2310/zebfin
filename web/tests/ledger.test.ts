// Offline unit tests for the browser-side ledger. Run: npx tsx --test tests/ledger.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  balanceSeries,
  buildLedger,
  monthly,
  quickbooksCsv,
  runwayMonths,
  unrealizedGainUsd,
  xeroCsv,
  type ChainTx,
  type LedgerContext,
} from "../src/lib/ledger";

const day = (d: string) => Date.parse(`${d}T12:00:00Z`) / 1000;
const ALICE = "utest1alice";
const BOB = "utest1bob";

const incoming: ChainTx = {
  txid: "aa".repeat(32),
  mined_height: 100,
  block_time: day("2026-09-01"),
  delta_zats: 50_000_000, // 0.5 ZEC received
  fee_zats: null,
  expired_unmined: false,
  outputs: [{ direction: "received", value_zats: 50_000_000, is_change: false, memo: "Grant tranche 1", to_address: null }],
};

const payroll: ChainTx = {
  txid: "bb".repeat(32),
  mined_height: 200,
  block_time: day("2026-10-01"),
  delta_zats: -(3_000_000 + 2_000_000 + 40_000), // two salaries + fee
  fee_zats: 40_000,
  expired_unmined: false,
  outputs: [
    { direction: "sent", value_zats: 3_000_000, is_change: false, memo: "Zebfin payslip | Alice", to_address: ALICE },
    { direction: "sent", value_zats: 2_000_000, is_change: false, memo: "Zebfin payslip | Bob", to_address: BOB },
    { direction: "internal", value_zats: 0, is_change: true, memo: null, to_address: null }, // padding
    { direction: "internal", value_zats: 0, is_change: true, memo: null, to_address: null }, // padding
    { direction: "internal", value_zats: 44_960_000, is_change: true, memo: null, to_address: null }, // change
  ],
};

const vendor: ChainTx = {
  txid: "cc".repeat(32),
  mined_height: 210,
  block_time: day("2026-10-05"),
  delta_zats: -(1_000_000 + 10_000),
  fee_zats: 10_000,
  expired_unmined: false,
  outputs: [{ direction: "sent", value_zats: 1_000_000, is_change: false, memo: "Invoice 42 hosting", to_address: "utest1vendor" }],
};

const expired: ChainTx = { ...vendor, txid: "dd".repeat(32), mined_height: null, block_time: null, expired_unmined: true };

function ctx(over: Partial<LedgerContext> = {}): LedgerContext {
  return {
    accounts: [{ id: "acct", name: "Operating", txs: [incoming, payroll, vendor, expired] }],
    contributorsByAddress: new Map([
      [ALICE, "Alice"],
      [BOB, "Bob"],
    ]),
    payrollByTxid: new Map([[payroll.txid, { period: "2026-10", ref: "PR-1" }]]),
    sentPayments: [],
    notes: new Map(),
    rules: [],
    prices: new Map([
      ["2026-09-01", { date: "2026-09-01", usd_per_zec: 1000, disputed: false }],
      ["2026-10-01", { date: "2026-10-01", usd_per_zec: 1200, disputed: false }],
      ["2026-10-05", { date: "2026-10-05", usd_per_zec: 1250, disputed: true }],
    ]),
    chainTip: 300,
    ...over,
  };
}

test("classifies income, payroll and spending; ignores padding, change and expired txs", () => {
  const { entries, expired: exp } = buildLedger(ctx());
  assert.equal(entries.length, 3);
  assert.deepEqual(exp.map((e) => e.txid), ["dd".repeat(32)]);

  const [v, p, i] = entries; // newest first
  assert.equal(i.direction, "in");
  assert.equal(i.amountZats, 50_000_000);
  assert.equal(i.category, "Revenue");
  assert.ok(i.flags.some((f) => f.includes("Unmatched incoming")));

  assert.equal(p.direction, "out");
  assert.equal(p.category, "Payroll");
  assert.equal(p.amountZats, 5_000_000, "salaries only: no change, padding or fee");
  assert.equal(p.feeZats, 40_000);
  assert.match(p.counterparty, /Payroll 2026-10 · 2 people/);

  assert.equal(v.category, "Uncategorized");
  assert.ok(v.flags.includes("Needs a category"));
  assert.ok(v.flags.some((f) => f.includes("disagreed")));
});

test("USD values use the daily price on the block date, signed by direction", () => {
  const { entries } = buildLedger(ctx());
  const byId = new Map(entries.map((e) => [e.txid, e]));
  assert.equal(byId.get(incoming.txid)!.usdValue, 500); // 0.5 ZEC * $1000
  assert.equal(byId.get(payroll.txid)!.usdValue!.toFixed(2), (-(5_040_000 / 1e8) * 1200).toFixed(2));
});

test("notes beat rules, rules beat defaults, payroll stays payroll", () => {
  const { entries } = buildLedger(
    ctx({
      rules: [
        { match: "memo", value: "hosting", category: "Software" },
        { match: "memo", value: "grant", category: "Grants received" },
      ],
      notes: new Map([[incoming.txid, { category: "Revenue", note: "actually a customer" }]]),
    }),
  );
  const byId = new Map(entries.map((e) => [e.txid, e]));
  assert.equal(byId.get(vendor.txid)!.category, "Software");
  assert.equal(byId.get(vendor.txid)!.categorySource, "rule");
  assert.equal(byId.get(incoming.txid)!.category, "Revenue");
  assert.equal(byId.get(incoming.txid)!.categorySource, "note");
  assert.ok(!byId.get(incoming.txid)!.flags.some((f) => f.includes("Unmatched")));
  assert.equal(byId.get(payroll.txid)!.category, "Payroll");
});

test("a payment the app sent but the chain doesn't show is flagged", () => {
  const { missingOnChain } = buildLedger(
    ctx({ sentPayments: [{ id: "p1", txid: "ee".repeat(32), accountId: "acct", status: "broadcast" }] }),
  );
  assert.deepEqual(missingOnChain, [{ id: "p1", txid: "ee".repeat(32) }]);
});

test("moves between two org accounts are transfers on both sides", () => {
  const move: ChainTx = {
    txid: "ff".repeat(32),
    mined_height: 250,
    block_time: day("2026-10-06"),
    delta_zats: -(4_000_000 + 10_000),
    fee_zats: 10_000,
    expired_unmined: false,
    outputs: [{ direction: "sent", value_zats: 4_000_000, is_change: false, memo: null, to_address: "utest1payroll" }],
  };
  const arrive: ChainTx = { ...move, delta_zats: 4_000_000, fee_zats: null, outputs: [{ ...move.outputs[0], direction: "received" }] };
  const { entries } = buildLedger(
    ctx({
      accounts: [
        { id: "op", name: "Operating", txs: [move] },
        { id: "pay", name: "Payroll", txs: [arrive] },
      ],
    }),
  );
  assert.deepEqual(entries.map((e) => [e.accountName, e.direction, e.category]), [
    ["Operating", "transfer", "Transfers"],
    ["Payroll", "transfer", "Transfers"],
  ]);
});

test("monthly totals, balance series, runway and unrealized gain", () => {
  const { entries } = buildLedger(ctx());
  const rows = monthly(entries);
  assert.deepEqual(rows.map((r) => r.month), ["2026-10", "2026-09"]);
  assert.equal(rows[1].incomeUsd, 500);
  assert.equal(rows[0].payrollUsd.toFixed(2), "60.00"); // 0.05 ZEC * 1200
  assert.equal(rows[0].otherSpendUsd.toFixed(2), "12.50");

  const series = balanceSeries(entries);
  assert.equal(series.at(-1)!.zats, 50_000_000 - 5_040_000 - 1_010_000);

  assert.ok(runwayMonths(1000, rows)! > 0);
  // Holding 0.4395 ZEC: worth $527.40 at $1200; basis = 500 - 60.48 - 12.625
  const gain = unrealizedGainUsd(entries, 43_950_000, 1200);
  assert.equal(gain.toFixed(2), (527.4 - (500 - 60.48 - 12.625)).toFixed(2));
});

test("exports: QuickBooks 3-column and Xero formats in USD", () => {
  const { entries } = buildLedger(ctx());
  const qb = quickbooksCsv(entries).trim().split("\n");
  assert.equal(qb[0], "Date,Description,Amount");
  assert.ok(qb.some((l) => l.startsWith("09/01/2026,") && l.endsWith(",500.00")));
  const xero = xeroCsv(entries).trim().split("\n");
  assert.equal(xero[0], "*Date,*Amount,Payee,Description,Reference");
  assert.equal(xero.length, 4);
});
