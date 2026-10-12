// Phase 5 gate on testnet: a live sealed-bid auction. Four independent bidder
// wallets post bonds with commitments; nobody can read a bid while bidding is
// open; three reveal after the deadline, one forfeits; the losing bonds are
// refunded on-chain. Slow (~15 min). Run with the server up:
//   npx tsx --test tests/auction.testnet.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { bondMemo, decide, newBid, parseBids, revealMemo, type AuctionRules, type BidReceipt } from "../src/lib/auction";
import { randomBytes } from "../src/lib/crypto";
import type { ChainTx } from "../src/lib/ledger";

const API = process.env.API ?? "http://localhost:8080";
const ROOT = path.resolve(import.meta.dirname, "../..");
const DEV = path.join(ROOT, ".dev");
const ZEBFIN = path.join(ROOT, "backend/target/debug/zebfin");
const signer = createRequire(import.meta.url)("../scripts/.signer-node/zebfin_signer.js");
const org = JSON.parse(fs.readFileSync(path.join(DEV, "api-org.json"), "utf8"));
// The auction runs from the dev org's second account (its own ZIP 32 account).
const auctionAccount = JSON.parse(fs.readFileSync(path.join(DEV, "api-account2.json"), "utf8")).account_id as string;
const auctionSeed = JSON.parse(fs.readFileSync(path.join(DEV, "contributor5.json"), "utf8")).mnemonic as string;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function call(method: string, p: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${org.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? {} : await res.json() };
}
const cli = (...args: string[]) => execFileSync(ZEBFIN, args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const psql = (sql: string) => execFileSync("psql", ["-h", "localhost", "-p", "5433", "-U", "zebfin", "-d", "zebfin", "-tAq", "-c", sql]);

/** A bidder pays from their own wallet: build, prove, sign with their seed, send. */
function pay(bidder: number, address: string, zats: number, memo: string): string {
  const w = path.join(DEV, `contributor${bidder}-wallet`);
  const tmp = path.join(DEV, `bid${bidder}`);
  cli("wallet", "sync", "-w", w);
  cli("pczt", "create", "-w", w, "--to", `${address}:${zats}:${memo}`, "--output", `${tmp}.created`);
  cli("pczt", "prove", `${tmp}.created`, "--output", `${tmp}.proven`);
  execFileSync(ZEBFIN, ["signer", "sign", "--key", path.join(DEV, `contributor${bidder}.json`), `${tmp}.created`, "--output", `${tmp}.signed`, "--yes"], { stdio: "ignore" });
  const txid = cli("pczt", "send", "-w", w, "--proven", `${tmp}.proven`, "--signed", `${tmp}.signed`).split("\n").at(-1)!;
  for (const ext of ["created", "proven", "signed"]) fs.rmSync(`${tmp}.${ext}`, { force: true });
  return txid;
}

async function auctionTxs(): Promise<ChainTx[]> {
  await call("POST", `/v1/accounts/${auctionAccount}/sync`);
  return (await call("GET", `/v1/accounts/${auctionAccount}/transactions`)).body as unknown as ChainTx[];
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 600_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(15_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const tempMembers: string[] = [];
after(() => {
  if (tempMembers.length) psql(`DELETE FROM members WHERE id IN (${tempMembers.map((m) => `'${m}'`).join(",")});`);
});

test("Phase 5 gate: a live sealed-bid auction on testnet", { timeout: 2_400_000 }, async () => {
  const address = (await call("POST", `/v1/accounts/${auctionAccount}/addresses`)).body.address as string;
  const start = Date.now();
  const rules: AuctionRules = {
    auctionId: randomUUID(),
    title: "Testnet logo design",
    description: "",
    kind: "procurement",
    pricing: "second-price",
    bondZats: 50_000,
    biddingEndsAt: new Date(start + 5 * 60_000).toISOString(),
    revealEndsAt: new Date(start + 14 * 60_000).toISOString(),
    address,
  };

  // Bidders 1-4 seal bids (USD cents) and post bonds; bidder 4 will never reveal.
  const prices: Record<number, number> = { 1: 120_00, 2: 95_00, 3: 110_00, 4: 50_00 };
  const receipts: Record<number, BidReceipt> = {};
  for (const i of [1, 2, 3, 4]) {
    const refund = cli("wallet", "address", "-w", path.join(DEV, `contributor${i}-wallet`));
    receipts[i] = newBid(rules.auctionId, prices[i], refund, randomBytes(32));
    pay(i, address, rules.bondZats, bondMemo(rules.auctionId, receipts[i].commitment, refund));
  }

  // While bidding is open: the organizer's view of the auction account holds
  // four valid bonds and not one bid value.
  const during = await until("4 mined bonds", async () => {
    const txs = await auctionTxs();
    const bids = parseBids(rules, txs);
    return bids.filter((b) => b.bondValid).length === 4 && txs;
  });
  assert.ok(Date.now() < Date.parse(rules.biddingEndsAt), "bonds landed before the deadline");
  // Structurally: every memo on the account is a bond (tag, commitment,
  // refund address): there is no field a bid value could be in.
  const memos = during.flatMap((t) => t.outputs.filter((o) => o.direction === "received").map((o) => o.memo ?? ""));
  assert.equal(memos.length, 4);
  for (const m of memos) {
    const parts = m.split("|");
    assert.equal(parts[0], "ZBID1");
    assert.equal(parts.length, 4, "tag, commitment, refund address only");
    assert.match(parts[2], /^[0-9a-f]{64}$/);
  }
  assert.equal(decide(rules, parseBids(rules, during)).winner, null, "nothing to decide before reveals");

  // After the deadline, three bidders reveal.
  await sleep(Math.max(0, Date.parse(rules.biddingEndsAt) - Date.now() + 5_000));
  for (const i of [1, 2, 3]) {
    const r = receipts[i];
    pay(i, address, 1000, revealMemo(rules.auctionId, r.commitment, r.bidCents, r.saltHex));
  }
  const bids = await until("3 valid reveals", async () => {
    const b = parseBids(rules, await auctionTxs());
    return b.filter((x) => x.revealed?.valid).length === 3 && b;
  });
  const outcome = decide(rules, bids);
  assert.equal(outcome.winner?.commitment, receipts[2].commitment, "lowest procurement bid wins");
  assert.equal(outcome.priceCents, 110_00, "second-price: paid the runner-up's bid");
  assert.deepEqual(outcome.forfeited.map((b) => b.commitment), [receipts[4].commitment]);
  assert.deepEqual(new Set(outcome.refunds.map((b) => b.refundAddress)), new Set([receipts[1].refundAddress, receipts[3].refundAddress]));

  // Close: refund the two losing bonds from the auction account in one transaction.
  const req = await call("POST", `/v1/accounts/${auctionAccount}/payments`, {
    kind: "refund",
    recipients: outcome.refunds.map((b) => ({ address: b.refundAddress, value_zats: b.bondZats, memo: "Zebfin auction bond refund" })),
  });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  for (let n = 0; n < req.body.approvals_required; n++) {
    const m = randomUUID();
    tempMembers.push(m);
    psql(`INSERT INTO members (id, org_id, role) VALUES ('${m}','${org.org_id}','approver');
          INSERT INTO approvals (payment_id, member_id, pczt_hash) VALUES ('${req.body.id}','${m}',decode('${req.body.content_hash}','hex'));`);
  }
  const built = await until("refund built", async () => {
    const b = await call("POST", `/v1/payments/${req.body.id}/build`);
    if (b.status !== 200) return null; // bonds may still be confirming
    for (let i = 0; i < 60; i++) {
      const p = await call("GET", `/v1/payments/${req.body.id}`);
      if (p.body.status === "awaiting_signature") return p.body;
      await sleep(2000);
    }
    return null;
  });
  const signed = Buffer.from(signer.sign(auctionSeed, 0, Buffer.from(built.pczt, "base64"))).toString("base64");
  const sent = await call("POST", `/v1/payments/${req.body.id}/signature`, { pczt: signed, send_now: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const txid = sent.body.txid as string;

  // Each losing bidder gets their bond back.
  for (const i of [1, 3]) {
    const w = path.join(DEV, `contributor${i}-wallet`);
    await until(`refund to bidder ${i}`, async () => {
      cli("wallet", "sync", "-w", w);
      const hist = JSON.parse(cli("wallet", "history", "-w", w));
      return hist.some((h: Json) => h.txid === txid && h.value_zats === rules.bondZats && h.direction === "received");
    });
  }
});
