// Integration tests against zebfin-server on Zcash testnet: real chain, real
// proofs, the Wasm signer. Run with the server up:
//   npx tsx --test tests/testnet.test.ts
// E2E_FULL=1 also waits for a payment to be mined and its memo decrypted.
//
// Uses the dev org in ../.dev (api-org.json, api-account.json, approver1.json)
// and the contributor wallets. Approvals are inserted directly into Postgres
// (the passkey ceremony itself needs a browser); everything else goes through
// the public API.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const API = process.env.API ?? "http://localhost:8080";
const ROOT = path.resolve(import.meta.dirname, "../..");
const DEV = path.join(ROOT, ".dev");
const ZEBFIN = path.join(ROOT, "backend/target/debug/zebfin");
const signer = createRequire(import.meta.url)("../scripts/.signer-node/zebfin_signer.js");
import { newBoxKeypair, newId, openPersonal, openSealed, randomBytes, sealPersonal, sealTo } from "../src/lib/crypto";
import { kudosMemo, leaderboards, settlementTotals } from "../src/lib/kudos";

const org = JSON.parse(fs.readFileSync(path.join(DEV, "api-org.json"), "utf8"));
const account = JSON.parse(fs.readFileSync(path.join(DEV, "api-account.json"), "utf8")).account_id as string;
const approver = JSON.parse(fs.readFileSync(path.join(DEV, "approver1.json"), "utf8"));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, p: string, body?: unknown, token = org.token): Promise<{ status: number; body: Json }> {
  const res = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? {} : await res.json() };
}

const contributorAddress = (i = 1) =>
  execFileSync(ZEBFIN, ["wallet", "address", "-w", path.join(DEV, `contributor${i}-wallet`)], { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();

/** Records a payment request (no transaction yet). */
const request = (recipients: Json[], kind = "payment") =>
  call("POST", `/v1/accounts/${account}/payments`, { recipients, kind });

/** Waits until change from earlier payments has confirmed. */
async function waitSpendable(minZats = 1_000_000) {
  for (let i = 0; i < 60; i++) {
    const b = (await call("GET", `/v1/accounts/${account}/balance`)).body;
    if (b.ironwood_spendable_zats + b.orchard_spendable_zats > minZats) return;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("no spendable funds after 10 minutes");
}

/** Builds an approved request and waits for proving. */
async function build(id: string) {
  const b = await call("POST", `/v1/payments/${id}/build`);
  if (b.status !== 200) return b;
  for (let i = 0; i < 60; i++) {
    const p = await call("GET", `/v1/payments/${id}`);
    if (p.body.status !== "proving") return p;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("proving timed out");
}

/** Request -> approve -> build, for tests that need a built transaction. */
async function createPayment(recipients: Json[]) {
  const r = await request(recipients);
  if (r.status !== 201) return r;
  approve(r.body.id, r.body.content_hash, r.body.approvals_required);
  return build(r.body.id);
}

const tempMembers: string[] = [];
const psql = (sql: string) =>
  execFileSync("psql", ["-h", "localhost", "-p", "5433", "-U", "zebfin", "-d", "zebfin", "-tAq", "-c", sql]);

/** Stands in for `n` passkey approvals of the request's content hash. */
function approve(paymentId: string, hash: string, n = 2) {
  for (let i = 0; i < n; i++) {
    const m = randomUUID();
    tempMembers.push(m);
    psql(`INSERT INTO members (id, org_id, role) VALUES ('${m}','${org.org_id}','approver');
          INSERT INTO approvals (payment_id, member_id, pczt_hash) VALUES ('${paymentId}','${m}',decode('${hash}','hex'));`);
  }
}

const sign = (pcztB64: string) => Buffer.from(signer.sign(approver.mnemonic, 0, Buffer.from(pcztB64, "base64"))).toString("base64");

/** Base58Check testnet P2PKH address, to prove transparent payees are refused. */
function testnetTransparent(): string {
  const payload = Buffer.concat([Buffer.from([0x1d, 0x25]), Buffer.alloc(20, 7)]);
  const sum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([payload, sum]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + bytes.toString("hex"));
  let out = "";
  const zero = BigInt(0), base = BigInt(58);
  while (n > zero) {
    out = alphabet[Number(n % base)] + out;
    n /= base;
  }
  return out;
}

const setPolicy = (policy: Json | null) =>
  psql(`UPDATE orgs SET policy = ${policy ? `'${JSON.stringify(policy)}'` : "NULL"} WHERE id = '${org.org_id}';`);

after(() => {
  setPolicy(null);
  psql(`DELETE FROM payees WHERE org_id = '${org.org_id}';`);
  if (tempMembers.length) psql(`DELETE FROM members WHERE id IN (${tempMembers.map((m) => `'${m}'`).join(",")});`);
});

describe("payroll on testnet", { concurrency: false }, () => {
  // Change from a previous run may still be confirming; building needs spendable funds.
  before(async () => {
    for (let i = 0; i < 60; i++) {
      const b = (await call("GET", `/v1/accounts/${account}/balance`)).body;
      if (b.ironwood_spendable_zats + b.orchard_spendable_zats > 1_000_000) return;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    throw new Error("no spendable funds after 10 minutes");
  }, { timeout: 620_000 });

  test("rejects payees that would break privacy or can't be paid", async () => {
    const t = await call("POST", `/v1/accounts/${account}/payments`, {
      recipients: [{ address: testnetTransparent(), value_zats: 1000 }],
    });
    assert.equal(t.status, 400);
    assert.match(t.body.error, /Orchard receiver/);

    const own = (await call("POST", `/v1/accounts/${account}/addresses`)).body.address;
    const o = await call("POST", `/v1/accounts/${account}/payments`, { recipients: [{ address: own, value_zats: 1000 }] });
    assert.equal(o.status, 400);
    assert.match(o.body.error, /own addresses/);

    const big = await call("POST", `/v1/accounts/${account}/payments`, {
      recipients: [{ address: contributorAddress(), value_zats: 1000 * 100_000_000 }],
    });
    assert.equal(big.status, 400);
    assert.match(big.body.error, /Can't pay this right now.*Insufficient/);

    const empty = await call("POST", `/v1/accounts/${account}/payments`, { recipients: [] });
    assert.equal(empty.status, 400);
  });

  test("pads 1- and 3-person runs to 8 shielded actions, and cancelling releases their notes", async () => {
    for (const n of [1, 3]) {
      const p = await createPayment(
        Array.from({ length: n }, (_, i) => ({ address: contributorAddress(i + 1), value_zats: 1000 + i })),
      );
      assert.equal(p.body.status, "awaiting_signature");
      const s = p.body.summary;
      assert.equal((s.orchard_actions + s.ironwood_actions) % 8, 0, `actions for ${n}`);
      assert.equal(s.payments.filter((x: Json) => x.value_zats > 0).length, n);
      assert.equal(s.fee_zats, 40_000);
      const c = await call("DELETE", `/v1/payments/${p.body.id}`);
      assert.equal(c.body.status, "cancelled");
    }
  });

  test("a built run's notes can't be picked by a second run until it's cancelled", async () => {
    const a = await createPayment([{ address: contributorAddress(), value_zats: 1000 }]);
    assert.equal(a.body.status, "awaiting_signature");
    // Requests don't lock anything, so the second request is accepted...
    const b = await request([{ address: contributorAddress(2), value_zats: 1000 }]);
    assert.equal(b.status, 201);
    approve(b.body.id, b.body.content_hash);
    // ...but building it can't take the notes reserved by `a`'s transaction.
    const blocked = await call("POST", `/v1/payments/${b.body.id}/build`);
    if (blocked.status === 200) {
      await call("DELETE", `/v1/payments/${b.body.id}`); // enough separate notes
    } else {
      assert.equal(blocked.status, 400, JSON.stringify(blocked.body));
      assert.equal((await call("GET", `/v1/payments/${b.body.id}`)).body.status, "approved", "still approved, can retry");
      await call("DELETE", `/v1/payments/${a.body.id}`);
      const retried = await build(b.body.id);
      assert.equal(retried.body.status, "awaiting_signature", "released notes are spendable again");
    }
    await call("DELETE", `/v1/payments/${b.body.id}`);
    await call("DELETE", `/v1/payments/${a.body.id}`);
  });

  test("only passkey members can approve; dev tokens can't", async () => {
    const p = await request([{ address: contributorAddress(), value_zats: 1000 }]);
    const r = await call("POST", `/v1/payments/${p.body.id}/approve/start`);
    assert.equal(r.status, 401);
    await call("DELETE", `/v1/payments/${p.body.id}`);
  });

  let sentPayment = "";
  test("nothing is built or signed before approval; wrong and repeated signatures are refused", async () => {
    const r = await request([{ address: contributorAddress(), value_zats: 2000, memo: "Zebfin payslip | e2e | ref PR-E2E" }]);
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "pending_approval");
    assert.equal(r.body.approvals_required, 2, "default policy: two-person rule");
    assert.match(r.body.content_hash, /^[0-9a-f]{64}$/);

    const early = await call("POST", `/v1/payments/${r.body.id}/build`);
    assert.equal(early.status, 409);
    assert.match(early.body.error, /only approved payments can be built/);
    const unsigned = await call("POST", `/v1/payments/${r.body.id}/signature`, { pczt: "AAAA" });
    assert.equal(unsigned.status, 409);

    approve(r.body.id, r.body.content_hash, 1);
    assert.equal((await call("GET", `/v1/payments/${r.body.id}`)).body.status, "pending_approval", "1 of 2");
    approve(r.body.id, r.body.content_hash, 1);
    assert.equal((await call("GET", `/v1/payments/${r.body.id}`)).body.status, "approved", "2 of 2");

    const a = await build(r.body.id);
    assert.equal(a.body.status, "awaiting_signature");
    const s = a.body.summary;
    assert.equal((s.orchard_actions + s.ironwood_actions) % 8, 0);

    // A genuine signature by the same seed, but over a different transaction.
    const fixture = fs.readFileSync(path.join(ROOT, "backend/crates/zebfin-signer/tests/fixtures/phase0-payment.created"));
    const wrong = await call("POST", `/v1/payments/${r.body.id}/signature`, { pczt: sign(fixture.toString("base64")) });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /does not match/);

    assert.throws(() => signer.sign(JSON.parse(signer.generateSeed(0)).mnemonic, 0, Buffer.from(a.body.pczt, "base64")), /No spends/);

    const ok = await call("POST", `/v1/payments/${r.body.id}/signature`, { pczt: sign(a.body.pczt), send_now: true });
    assert.equal(ok.status, 200);
    assert.ok(["broadcast", "sending"].includes(ok.body.status), ok.body.status);
    assert.match(ok.body.txid ?? "", /^[0-9a-f]{64}$/);
    sentPayment = r.body.id;

    assert.equal((await call("POST", `/v1/payments/${r.body.id}/signature`, { pczt: sign(a.body.pczt) })).status, 409);
    assert.equal((await call("DELETE", `/v1/payments/${r.body.id}`)).status, 409, "a sent payment can't be cancelled");
  });

  test("approval tiers scale with the USD amount", async () => {
    setPolicy({ tiers: [{ above_usd: 0, approvals: 1 }, { above_usd: 0.01, approvals: 2 }, { above_usd: 0.05, approvals: 3 }],
      daily_cap_usd: null, monthly_cap_usd: null, new_payee_hold_above_usd: 1000, new_payee_hold_hours: 24 });
    const rate = (await call("GET", "/v1/rates/zec-usd")).body.usd_per_zec as number;
    const zatsFor = (usd: number) => Math.round((usd / rate) * 1e8);
    const cases: [number, number][] = [[0.005, 1], [0.02, 2], [0.08, 3]];
    for (const [usd, need] of cases) {
      const r = await request([{ address: contributorAddress(), value_zats: zatsFor(usd) }]);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.approvals_required, need, `$${usd}`);
      await call("DELETE", `/v1/payments/${r.body.id}`);
    }
  });

  test("daily cap refuses requests beyond it", async () => {
    const rate = (await call("GET", "/v1/rates/zec-usd")).body.usd_per_zec as number;
    // Existing requests in the last 24h count toward the cap, so set it just above what's there.
    setPolicy({ tiers: [{ above_usd: 0, approvals: 2 }], daily_cap_usd: 1e9, monthly_cap_usd: null, new_payee_hold_above_usd: 1000, new_payee_hold_hours: 24 });
    const probe = await request([{ address: contributorAddress(), value_zats: 1000 }]);
    await call("DELETE", `/v1/payments/${probe.body.id}`);
    setPolicy({ tiers: [{ above_usd: 0, approvals: 2 }], daily_cap_usd: 0.000001, monthly_cap_usd: null, new_payee_hold_above_usd: 1000, new_payee_hold_hours: 24 });
    const over = await request([{ address: contributorAddress(), value_zats: Math.round((0.05 / rate) * 1e8) }]);
    assert.equal(over.status, 400);
    assert.match(over.body.error, /daily cap/);
  });

  test("large payments to new payees are held until they've been in the payee book long enough", async () => {
    setPolicy({ tiers: [{ above_usd: 0, approvals: 2 }], daily_cap_usd: null, monthly_cap_usd: null, new_payee_hold_above_usd: 0.01, new_payee_hold_hours: 24 });
    const rate = (await call("GET", "/v1/rates/zec-usd")).body.usd_per_zec as number;
    const big = Math.round((0.05 / rate) * 1e8);
    const small = Math.round((0.005 / rate) * 1e8);
    const payee = contributorAddress(4);
    const hash = createHash("sha256").update(`zebfin/payee/v1|${payee}`).digest("hex");

    const unknown = await request([{ address: payee, value_zats: big }]);
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /new payee.*not in the payee book/);

    const tiny = await request([{ address: payee, value_zats: small }]);
    assert.equal(tiny.status, 201, "small payments aren't held");
    await call("DELETE", `/v1/payments/${tiny.body.id}`);

    psql(`INSERT INTO payees (org_id, address_hash) VALUES ('${org.org_id}', decode('${hash}','hex'));`);
    const fresh = await request([{ address: payee, value_zats: big }]);
    assert.equal(fresh.status, 400, "added just now: still held");
    assert.match(fresh.body.error, /added/);

    psql(`UPDATE payees SET added_at = now() - interval '25 hours' WHERE org_id = '${org.org_id}';`);
    const ok = await request([{ address: payee, value_zats: big }]);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    await call("DELETE", `/v1/payments/${ok.body.id}`);
    setPolicy(null);
  });

  test("Phase 3 gate: a payment above a tier can't be built without that tier's approvals", async () => {
    setPolicy({ tiers: [{ above_usd: 0, approvals: 1 }, { above_usd: 0.05, approvals: 3 }],
      daily_cap_usd: null, monthly_cap_usd: null, new_payee_hold_above_usd: 1000, new_payee_hold_hours: 24 });
    const rate = (await call("GET", "/v1/rates/zec-usd")).body.usd_per_zec as number;
    const r = await request([{ address: contributorAddress(), value_zats: Math.round((0.08 / rate) * 1e8) }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.approvals_required, 3);
    approve(r.body.id, r.body.content_hash, 2);
    const two = await call("POST", `/v1/payments/${r.body.id}/build`);
    assert.equal(two.status, 409, "2 of 3 isn't enough");
    approve(r.body.id, r.body.content_hash, 1);
    assert.equal((await call("GET", `/v1/payments/${r.body.id}`)).body.status, "approved", "3 of 3");
    // An approval of different content doesn't count.
    const other = await request([{ address: contributorAddress(), value_zats: Math.round((0.08 / rate) * 1e8) + 1 }]);
    approve(other.body.id, r.body.content_hash, 3);
    assert.equal((await call("GET", `/v1/payments/${other.body.id}`)).body.status, "pending_approval");
    await call("DELETE", `/v1/payments/${r.body.id}`);
    await call("DELETE", `/v1/payments/${other.body.id}`);
    setPolicy(null);
  });

  test("transfers must go to another of the org's own accounts, and skip the new-payee hold", async () => {
    const second = path.join(DEV, "api-account2.json");
    if (!fs.existsSync(second)) {
      const exp = JSON.parse(fs.readFileSync(path.join(DEV, "contributor5-export.json"), "utf8"));
      const tip = (await call("GET", `/v1/accounts/${account}/balance`)).body.chain_tip as number;
      const a = await call("POST", "/v1/accounts", { ufvk: exp.ufvk, seed_fingerprint: exp.seed_fingerprint, account_index: 0, birthday: tip - 10 });
      assert.equal(a.status, 201, JSON.stringify(a.body));
      fs.writeFileSync(second, JSON.stringify(a.body));
    }
    const other = JSON.parse(fs.readFileSync(second, "utf8")).account_id as string;
    setPolicy({ tiers: [{ above_usd: 0, approvals: 2 }], daily_cap_usd: null, monthly_cap_usd: null, new_payee_hold_above_usd: 0, new_payee_hold_hours: 24 });

    const outsider = await call("POST", `/v1/accounts/${account}/payments`, { kind: "transfer", recipients: [{ address: contributorAddress(), value_zats: 5000 }] });
    assert.equal(outsider.status, 400);
    assert.match(outsider.body.error, /another of this org's accounts/);

    const dest = (await call("POST", `/v1/accounts/${other}/addresses`)).body.address;
    const asPayment = await call("POST", `/v1/accounts/${account}/payments`, { kind: "payment", recipients: [{ address: dest, value_zats: 5000 }] });
    assert.equal(asPayment.status, 400, "as an ordinary payment it's a new payee");
    const t = await call("POST", `/v1/accounts/${account}/payments`, { kind: "transfer", recipients: [{ address: dest, value_zats: 5000 }] });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.equal(t.body.kind, "transfer");
    await call("DELETE", `/v1/payments/${t.body.id}`);
    setPolicy(null);
  });

  test("Phase 3 gate: auditor links are scoped, read-only and expire", async () => {
    const card = Buffer.alloc(300, 9).toString("base64");
    const verifier = Buffer.alloc(32, 5);
    const noExpiry = await call("POST", "/v1/portals", { verifier: verifier.toString("base64"), card_ciphertext: card, kind: "audit" });
    assert.equal(noExpiry.status, 400, "audit links must expire");
    const p = await call("POST", "/v1/portals", { verifier: verifier.toString("base64"), card_ciphertext: card, kind: "audit", expires_in_days: 7 });
    assert.equal(p.status, 201);
    const asAuditor = (init: RequestInit = {}) =>
      fetch(`${API}/v1/portal/${p.body.portal_id}${init.method === "PUT" ? "/response" : ""}`, {
        ...init,
        headers: { "x-portal-verifier": verifier.toString("base64"), "content-type": "application/json" },
      });
    const ok = await asAuditor();
    assert.equal(ok.status, 200);
    const view = await ok.json();
    assert.equal(view.kind, "audit");
    assert.ok(view.expires_at);
    const write = await asAuditor({ method: "PUT", body: JSON.stringify({ ciphertext: card }) });
    assert.equal(write.status, 403, "read-only");
    psql(`UPDATE portals SET expires_at = now() - interval '1 minute' WHERE id = '${p.body.portal_id}';`);
    assert.equal((await asAuditor()).status, 403, "expired");
    await call("DELETE", `/v1/portals/${p.body.portal_id}`);
    // Viewing keys are admin-only (passkey session), never for tokens.
    assert.equal((await call("GET", `/v1/accounts/${account}/viewing-key`)).status, 401);
  });

  test("orgs are isolated from each other", async () => {
    const other = await fetch(`${API}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meta_ciphertext: Buffer.alloc(64, 1).toString("base64") }),
    }).then((r) => r.json());
    const asOther = (m: string, p: string) => call(m, p, undefined, other.token);
    assert.equal((await asOther("GET", `/v1/accounts/${account}/balance`)).status, 404);
    assert.equal((await asOther("GET", `/v1/accounts/${account}/history`)).status, 404);
    if (sentPayment) assert.equal((await asOther("GET", `/v1/payments/${sentPayment}`)).status, 404);
    assert.deepEqual((await asOther("GET", "/v1/accounts")).body, []);
    assert.deepEqual((await asOther("GET", "/v1/records")).body, []);
  });

  test("portals refuse a wrong link key", async () => {
    const res = await fetch(`${API}/v1/portal/${randomUUID()}`, {
      headers: { "x-portal-verifier": Buffer.alloc(32, 3).toString("base64") },
    });
    assert.ok([401, 404].includes(res.status));
  });

  let kudosPayment = "";
  test("Phase 4 gate: a month of kudos settles in one padded transaction; amounts stay sealed", { timeout: 900_000 }, async () => {
    // Members m1..m3 are paid at contributor wallets 1..3; m4 only gives.
    const settler = newBoxKeypair();
    const personal: Record<string, Uint8Array> = { m1: randomBytes(32), m2: randomBytes(32), m3: randomBytes(32), m4: randomBytes(32) };
    const given: [string, string, number, string][] = [
      ["m1", "m2", 0.02, "shipped the release"],
      ["m3", "m2", 0.03, "unblocked me"],
      ["m2", "m1", 0.01, "great review"],
      ["m4", "m3", 0.02, "helped a customer"],
      ["m4", "m2", 0.05, "on-call hero"], // m2 goes over the cap below
    ];
    const month = new Date().toISOString().slice(0, 7);
    const records = given.map(([from, to, usd, note]) => {
      const id = newId();
      return { id, from, to, note, tag: "Helping", month, at: new Date().toISOString(),
        amountForSettler: sealTo(settler.publicKey, { usd }, `kudos|${id}`),
        amountForGiver: sealPersonal(personal[from], { usd }, `kudos|${id}`) };
    });

    // No teammate can read another's amount: not with their personal key, not as a sealed box.
    const r0 = records[0];
    assert.equal(openPersonal<{ usd: number }>(personal.m1, r0.amountForGiver, `kudos|${r0.id}`).usd, 0.02, "giver reads own");
    assert.throws(() => openPersonal(personal.m2, r0.amountForGiver, `kudos|${r0.id}`), "recipient can't");
    assert.throws(() => openSealed(newBoxKeypair().secretKey, r0.amountForSettler, `kudos|${r0.id}`), "others can't");
    // What the team sees: counts only.
    const lb = leaderboards(records, month);
    assert.deepEqual(lb.mostAppreciated[0], { memberId: "m2", count: 3 });

    // The settler opens and totals (cap $0.08 per recipient).
    const opened = records.map((r) => ({ ...r, usd: openSealed<{ usd: number }>(settler.secretKey, r.amountForSettler, `kudos|${r.id}`).usd }));
    const lines = settlementTotals(opened, month, 0.08);
    const m2 = lines.find((l) => l.memberId === "m2")!;
    assert.ok(m2.capped && Math.abs(m2.usd - 0.08) < 1e-9);

    const rate = (await call("GET", "/v1/rates/zec-usd")).body.usd_per_zec as number;
    const wallet: Record<string, number> = { m1: 1, m2: 2, m3: 3 };
    const names: Record<string, string> = { m1: "Alice", m2: "Bob", m3: "Chen", m4: "Dana" };
    const recipients = lines.map((l) => ({
      address: contributorAddress(wallet[l.memberId]),
      value_zats: Math.round((l.usd / rate) * 1e8),
      memo: kudosMemo(month, l, (id) => names[id]),
    }));
    const r = await call("POST", `/v1/accounts/${account}/payments`, { kind: "kudos", recipients });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    approve(r.body.id, r.body.content_hash, r.body.approvals_required);
    await waitSpendable(); // change from the previous test's payment may still be confirming
    const built = await build(r.body.id);
    assert.equal(built.body.status, "awaiting_signature", JSON.stringify(built.body));
    const s = built.body.summary;
    assert.equal(s.orchard_actions + s.ironwood_actions, 8, "one transaction, padded to 8 actions");
    assert.equal(s.payments.filter((x: Json) => x.value_zats > 0).length, 3);
    const sent = await call("POST", `/v1/payments/${r.body.id}/signature`, { pczt: sign(built.body.pczt), send_now: true });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    kudosPayment = r.body.id;
  });

  test("each kudos recipient decrypts only their own memo", { skip: !process.env.E2E_FULL, timeout: 900_000 }, async () => {
    let p: Json = {};
    for (let i = 0; i < 60; i++) {
      p = (await call("GET", `/v1/payments/${kudosPayment}`)).body;
      if (p.status === "mined" || p.status === "failed") break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    assert.equal(p.status, "mined");
    const expected: Record<number, string> = { 1: "great review", 2: "on-call hero", 3: "helped a customer" };
    for (const [w, note] of Object.entries(expected)) {
      const dir = path.join(DEV, `contributor${w}-wallet`);
      let memo: string | undefined;
      for (let i = 0; i < 12 && !memo; i++) {
        execFileSync(ZEBFIN, ["wallet", "sync", "-w", dir], { stdio: "ignore" });
        const hist = JSON.parse(execFileSync(ZEBFIN, ["wallet", "history", "-w", dir], { stdio: ["ignore", "pipe", "ignore"] }).toString());
        memo = hist.find((h: Json) => h.txid === p.txid)?.memo;
        if (!memo) await new Promise((r) => setTimeout(r, 10_000));
      }
      assert.ok(memo?.startsWith("Zebfin kudos"), `wallet ${w}`);
      assert.ok(memo!.includes(note), `wallet ${w} sees its own thank-you`);
      for (const [other, otherNote] of Object.entries(expected)) if (other !== w) assert.ok(!memo!.includes(otherNote));
    }
  });

  test("the sent payment is mined and the recipient decrypts its memo", { skip: !process.env.E2E_FULL }, async () => {
    assert.ok(sentPayment, "previous test sent a payment");
    let p: Json = {};
    for (let i = 0; i < 60; i++) {
      p = (await call("GET", `/v1/payments/${sentPayment}`)).body;
      if (p.status === "mined" || p.status === "failed") break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    assert.equal(p.status, "mined");
    const w = path.join(DEV, "contributor1-wallet");
    for (let i = 0; i < 12; i++) {
      execFileSync(ZEBFIN, ["wallet", "sync", "-w", w], { stdio: "ignore" });
      const hist = JSON.parse(execFileSync(ZEBFIN, ["wallet", "history", "-w", w], { stdio: ["ignore", "pipe", "ignore"] }).toString());
      const mine = hist.find((h: Json) => h.txid === p.txid && h.memo?.includes("PR-E2E"));
      if (mine) return assert.equal(mine.value_zats, 2000);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    assert.fail("recipient never saw the payment");
  });
});
