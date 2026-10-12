// Sends testnet TAZ from the dev org's funded account to an address, e.g. a new
// demo org's treasury ("New receiving address" in the dashboard).
//   npm run demo:fund -- <address> [taz=0.05]
//
// Uses the dev org in ../.dev (api-org.json, api-account.json, approver1.json).
// As in the testnet tests, the two approvals are inserted directly into
// Postgres (passkey approvals need a browser); the temporary approvers are
// removed afterwards. Needs zebfin-server running.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const API = process.env.API ?? "http://localhost:8080";
const ROOT = path.resolve(import.meta.dirname, "../..");
const DEV = path.join(ROOT, ".dev");
const signer = createRequire(import.meta.url)("./.signer-node/zebfin_signer.js");
const org = JSON.parse(fs.readFileSync(path.join(DEV, "api-org.json"), "utf8"));
const account = JSON.parse(fs.readFileSync(path.join(DEV, "api-account.json"), "utf8")).account_id as string;
const approver = JSON.parse(fs.readFileSync(path.join(DEV, "approver1.json"), "utf8"));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, p: string, body?: unknown): Promise<Json> {
  const res = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${org.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${json.error ?? JSON.stringify(json)}`);
  return json;
}
const psql = (sql: string) => execFileSync("psql", ["-h", "localhost", "-p", "5433", "-U", "zebfin", "-d", "zebfin", "-tAq", "-c", sql]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const [to, tazArg] = process.argv.slice(2);
if (!to) {
  console.error("usage: npm run demo:fund -- <address> [taz=0.05]");
  process.exit(1);
}


async function main() {
  const zats = Math.round(Number(tazArg ?? "0.05") * 1e8);

  const balance = await call("GET", `/v1/accounts/${account}/balance`);
  const spendable = balance.orchard_spendable_zats + balance.ironwood_spendable_zats;
  console.log(`Dev account: ${(balance.total_zats / 1e8).toFixed(4)} TAZ (${(spendable / 1e8).toFixed(4)} spendable)`);
  if (spendable < zats + 100_000) throw new Error("not enough spendable TAZ in the dev account (change may still be confirming)");

  const req = await call("POST", `/v1/accounts/${account}/payments`, {
    recipients: [{ address: to, value_zats: zats, memo: "Zebfin demo funding" }],
    kind: "payment",
  });
  const temp: string[] = [];
  try {
    for (let i = 0; i < req.approvals_required; i++) {
      const m = randomUUID();
      temp.push(m);
      psql(`INSERT INTO members (id, org_id, role) VALUES ('${m}','${org.org_id}','approver');
            INSERT INTO approvals (payment_id, member_id, pczt_hash) VALUES ('${req.id}','${m}',decode('${req.content_hash}','hex'));`);
    }
    console.log("Approved; building and proving…");
    await call("POST", `/v1/payments/${req.id}/build`);
    let p = await call("GET", `/v1/payments/${req.id}`);
    for (let i = 0; p.status === "proving" && i < 90; i++) {
      await sleep(2000);
      p = await call("GET", `/v1/payments/${req.id}`);
    }
    if (p.status !== "awaiting_signature") throw new Error(`unexpected status ${p.status}: ${p.error ?? ""}`);
    const signed = Buffer.from(signer.sign(approver.mnemonic, 0, Buffer.from(p.pczt, "base64"))).toString("base64");
    const sent = await call("POST", `/v1/payments/${req.id}/signature`, { pczt: signed, send_now: true });
    for (let i = 0; !sent.txid && i < 30; i++) {
      await sleep(2000);
      Object.assign(sent, await call("GET", `/v1/payments/${req.id}`));
    }
    console.log(`Sent ${zats / 1e8} TAZ: ${sent.status} ${sent.txid ?? ""}`);
    console.log("It shows in the new org after a block or two (~25 s each); spendable after ~3 confirmations.");
  } finally {
    if (temp.length) psql(`DELETE FROM approvals WHERE member_id IN (${temp.map((m) => `'${m}'`).join(",")});
                           DELETE FROM members WHERE id IN (${temp.map((m) => `'${m}'`).join(",")});`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
