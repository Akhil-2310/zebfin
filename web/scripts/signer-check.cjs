// Signs a pending payment with the Wasm signer (Node build) and submits it.
// Usage: node scripts/signer-check.cjs <payment-id>   (needs ../.dev/api-org.json, ../.dev/approver1.json)
const fs = require("node:fs");
const path = require("node:path");
const w = require("./.signer-node/zebfin_signer.js");

const API = process.env.API ?? "http://localhost:8080";
const dev = path.join(__dirname, "../../.dev");
const { token } = JSON.parse(fs.readFileSync(path.join(dev, "api-org.json")));
const { mnemonic, account_index } = JSON.parse(fs.readFileSync(path.join(dev, "approver1.json")));
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

(async () => {
  const id = process.argv[2];
  const p = await (await fetch(`${API}/v1/payments/${id}`, { headers: auth })).json();
  console.log("status:", p.status);
  const created = Buffer.from(p.pczt, "base64");

  const local = JSON.parse(w.summarize(created));
  console.log("decoded locally by Wasm:", JSON.stringify({ payments: local.payments, fee: local.fee_zats, actions: local.ironwood_actions }));
  if (JSON.stringify(local.payments) !== JSON.stringify(p.summary.payments)) throw new Error("server summary disagrees with local decode");

  console.log("export matches CLI key:", JSON.parse(w.exportAccount(mnemonic, account_index)).seed_fingerprint.slice(0, 16) + "…");
  const t = Date.now();
  const signed = w.sign(mnemonic, account_index, created);
  console.log(`signed in ${Date.now() - t} ms (${signed.length} bytes)`);

  try { w.sign(JSON.parse(w.generateSeed(0)).mnemonic, 0, created); throw new Error("should fail"); }
  catch (e) { console.log("wrong seed rejected:", e.message); }

  const r = await fetch(`${API}/v1/payments/${id}/signature`, { method: "POST", headers: auth, body: JSON.stringify({ pczt: Buffer.from(signed).toString("base64") }) });
  console.log("submit:", r.status, JSON.stringify(await r.json()));
})().catch((e) => { console.error(e); process.exit(1); });
