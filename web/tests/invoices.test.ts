// Offline tests for invoice matching and ZIP 321 URIs. Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchInvoice, zip321Uri } from "../src/lib/invoices";
import type { ChainTx } from "../src/lib/ledger";

const ADDR = "utest1invoiceaddress";
const tx = (txid: string, value: number, to = ADDR, height: number | null = 100): ChainTx => ({
  txid,
  mined_height: height,
  block_time: 1,
  delta_zats: value,
  fee_zats: null,
  expired_unmined: false,
  outputs: [{ direction: "received", value_zats: value, is_change: false, memo: "INV-0001", to_address: to }],
});

test("ZIP 321 URI carries amount in ZEC, base64url memo and message", () => {
  const uri = zip321Uri(ADDR, 12_345_000, "Acme INV-0001", "Acme invoice INV-0001");
  assert.ok(uri.startsWith(`zcash:${ADDR}?amount=0.12345&memo=`));
  const memo = new URL(uri.replace("zcash:", "http://x/")).searchParams.get("memo")!;
  assert.match(memo, /^[A-Za-z0-9_-]+$/, "base64url, no padding");
  assert.equal(Buffer.from(memo, "base64url").toString(), "Acme INV-0001");
  assert.ok(uri.endsWith("message=Acme%20invoice%20INV-0001"));
});

test("matches payments by the invoice's own address only", () => {
  const inv = { address: ADDR, zats: 1_000_000 };
  assert.equal(matchInvoice(inv, []).status, "unpaid");
  assert.equal(matchInvoice(inv, [tx("a", 400_000)]).status, "part-paid");
  const paid = matchInvoice(inv, [tx("a", 400_000), tx("b", 600_000)]);
  assert.equal(paid.status, "paid");
  assert.equal(paid.receivedZats, 1_000_000);
  assert.equal(matchInvoice(inv, [tx("a", 1_500_000)]).status, "overpaid");
  assert.equal(matchInvoice(inv, [tx("a", 1_000_000, "utest1someoneelse")]).status, "unpaid", "other addresses don't count");
  assert.equal(matchInvoice(inv, [tx("a", 999_995)]).status, "paid", "within rounding tolerance");
});
