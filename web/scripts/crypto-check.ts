// Checks the browser crypto against the real API, minus WebAuthn:
// run with `npx tsx scripts/crypto-check.ts` while zebfin-server is up.
import assert from "node:assert/strict";
import {
  decryptJson, encryptJson, fromB64, metaAad, newId, newOrgKey, newRecoveryPhrase,
  passkeySlot, passkeyWrapKey, randomBytes, recordAad, recoveryMaterial, toB64,
  unwrapOrgKey, wrapOrgKey, isValidRecoveryPhrase,
} from "../src/lib/crypto";

const API = process.env.API ?? "http://localhost:8080";

async function main() {
  // 1. Wrap/unwrap with a simulated PRF output, and tamper detection.
  const orgKey = newOrgKey();
  const orgId = newId();
  const rawId = randomBytes(32);
  const prf = randomBytes(32);
  const slot = passkeySlot(rawId);
  const wrapped = wrapOrgKey(passkeyWrapKey(prf, slot), orgKey, orgId, slot);
  assert.deepEqual(unwrapOrgKey(passkeyWrapKey(prf, slot), wrapped, orgId, slot), orgKey);
  assert.throws(() => unwrapOrgKey(passkeyWrapKey(randomBytes(32), slot), wrapped, orgId, slot), "wrong PRF must fail");
  assert.throws(() => unwrapOrgKey(passkeyWrapKey(prf, slot), wrapped, newId(), slot), "wrong org must fail");
  console.log("✓ passkey wrap/unwrap, wrong key and wrong org rejected");

  // 2. Recovery kit: deterministic from the words, unwraps the org key.
  const phrase = newRecoveryPhrase();
  assert.equal(phrase.split(" ").length, 24);
  assert.ok(isValidRecoveryPhrase(phrase.toUpperCase() + "  "));
  const m1 = recoveryMaterial(phrase), m2 = recoveryMaterial(phrase);
  assert.deepEqual(m1.lookupId, m2.lookupId);
  assert.notDeepEqual(m1.lookupId, m1.verifier);
  const rw = wrapOrgKey(m1.wrapKey, orgKey, orgId, m1.slot);
  assert.deepEqual(unwrapOrgKey(m2.wrapKey, rw, orgId, m2.slot), orgKey);
  console.log("✓ recovery kit derives stable, domain-separated keys and unwraps the org key");

  // 3. Padding hides length: short and long records land in the same bucket.
  const a = encryptJson(orgKey, "x", { n: "Al" });
  const b = encryptJson(orgKey, "x", { n: "A much longer contributor name with a role and notes".repeat(3) });
  assert.equal(a.length, b.length);
  console.log(`✓ padding: short and long records are both ${a.length} bytes`);

  // 4. Records through the real API (dev token org), then check the server copy.
  const meta = { name: "Crypto Check Co" };
  const created = await (await fetch(`${API}/v1/orgs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ meta_ciphertext: toB64(encryptJson(orgKey, metaAad(orgId), meta)) }),
  })).json();
  // The server picked its own org id; re-encrypt meta bound to it.
  const realOrg = created.org_id as string;
  const auth = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${API}/v1/org`, { method: "PUT", headers: auth, body: JSON.stringify({ meta_ciphertext: toB64(encryptJson(orgKey, metaAad(realOrg), meta)) }) });

  const rid = newId();
  const secret = { type: "contributor", name: "Alice Secret", role: "Engineer", address: "utest1xyz", monthlyTaz: 0.5 };
  const put = await fetch(`${API}/v1/records/${rid}`, { method: "PUT", headers: auth, body: JSON.stringify({ ciphertext: toB64(encryptJson(orgKey, recordAad(realOrg, rid), secret)) }) });
  assert.equal(put.status, 204);
  const got = await (await fetch(`${API}/v1/records/${rid}`, { headers: auth })).json();
  const raw = fromB64(got.ciphertext);
  assert.ok(!Buffer.from(raw).toString("latin1").includes("Alice"), "server copy must not contain plaintext");
  assert.deepEqual(decryptJson(orgKey, recordAad(realOrg, rid), raw), secret);
  assert.throws(() => decryptJson(orgKey, recordAad(realOrg, newId()), raw), "record moved to another id must fail");
  console.log(`✓ record round-trips through the API as ${raw.length} opaque bytes; swapping record IDs is detected`);
  console.log(`  (test org ${realOrg})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
