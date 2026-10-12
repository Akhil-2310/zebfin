// Admin half of the contributor-portal check (dev token org).
// step=create: makes a portal, prints its fragment. step=finish <portalId> <secret>: reads the
// contributor's address and posts a payslip.
import fs from "node:fs";
import { createPortal, postPayslip, readResponse } from "../src/lib/portal";

const dev = JSON.parse(fs.readFileSync("../.dev/api-org.json", "utf8"));
const session = { token: dev.token, orgId: dev.org_id, memberId: "", orgKey: new Uint8Array(32), orgName: "Crypto Check Co", passkeyRawId: new Uint8Array(), personalKey: new Uint8Array(32) };

(async () => {
  const [step, portalId, secret] = process.argv.slice(2);
  if (step === "create") {
    const p = await createPortal(session, { orgName: session.orgName, contributorName: "Bob", role: "Designer" });
    console.log(`${p.portalId}.${p.secret}`);
  } else {
    const r = await readResponse(session, portalId, secret);
    console.log("org decrypted contributor address:", r?.address.slice(0, 24) + "…");
    await postPayslip(session, portalId, secret, {
      period: "2026-10", ref: "PR-PORTAL1", amountZats: 150000, memo: "Zebfin payslip | 2026-10 | Bob (Designer) | 0.0015 TAZ | ref PR-PORTAL1",
      orgName: session.orgName, contributorName: "Bob", role: "Designer", issuedAt: new Date().toISOString(),
    });
    console.log("payslip posted");
  }
})().catch((e) => { console.error(e); process.exit(1); });
