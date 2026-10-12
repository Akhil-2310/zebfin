// Browser-side cryptography for Zebfin. Nothing in this file talks to the
// network: the server only ever receives the ciphertexts produced here.
//
// - Records:   XChaCha20-Poly1305 under the 256-bit org key, padded to fixed
//              size buckets, bound to (org, record id) via associated data.
// - Org key:   wrapped per passkey (key derived from the WebAuthn PRF output)
//              and once for the 24-word recovery kit.

import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

const enc = new TextEncoder();
const dec = new TextDecoder();

export { randomBytes };

// ---------- encoding helpers ----------

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Formats 16 bytes as a UUID string (version nibble set to 8, "custom"). */
function bytesToUuid(b: Uint8Array): string {
  const x = Uint8Array.from(b.slice(0, 16));
  x[6] = (x[6] & 0x0f) | 0x80;
  x[8] = (x[8] & 0x3f) | 0x80;
  const h = Array.from(x, (v) => v.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- AEAD ----------

function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce, enc.encode(aad)).encrypt(plaintext);
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce);
  out.set(ct, 24);
  return out;
}

function open(key: Uint8Array, sealed: Uint8Array, aad: string): Uint8Array {
  if (sealed.length < 24 + 16) throw new Error("ciphertext too short");
  return xchacha20poly1305(key, sealed.slice(0, 24), enc.encode(aad)).decrypt(sealed.slice(24));
}

// ---------- padding ----------

// Plaintexts are padded to one of these sizes so the server can't tell a
// short note from a long one, or a 3-person list from a 30-person one.
const BUCKETS = [256, 1024, 4096, 16384, 65536, 200_000];

function pad(data: Uint8Array): Uint8Array {
  const needed = data.length + 4;
  const size = BUCKETS.find((b) => b >= needed);
  if (!size) throw new Error("record too large");
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, 4);
  return out;
}

function unpad(padded: Uint8Array): Uint8Array {
  const len = new DataView(padded.buffer, padded.byteOffset).getUint32(0);
  if (len > padded.length - 4) throw new Error("bad padding");
  return padded.slice(4, 4 + len);
}

// ---------- org key and records ----------

export function newOrgKey(): Uint8Array {
  return randomBytes(32);
}

export function newId(): string {
  return bytesToUuid(randomBytes(16));
}

export function encryptJson(orgKey: Uint8Array, aad: string, value: unknown): Uint8Array {
  return seal(orgKey, pad(enc.encode(JSON.stringify(value))), aad);
}

export function decryptJson<T>(orgKey: Uint8Array, aad: string, sealed: Uint8Array): T {
  return JSON.parse(dec.decode(unpad(open(orgKey, sealed, aad)))) as T;
}

export const metaAad = (orgId: string) => `zebfin/meta/v1|${orgId}`;
export const recordAad = (orgId: string, recordId: string) => `zebfin/record/v1|${orgId}|${recordId}`;

// ---------- key wrapping ----------

const keyAad = (orgId: string, slot: string, version: number) =>
  `zebfin/orgkey/v1|${orgId}|${slot}|${version}`;

export function wrapOrgKey(wrapKey: Uint8Array, orgKey: Uint8Array, orgId: string, slot: string, version = 1) {
  return seal(wrapKey, orgKey, keyAad(orgId, slot, version));
}

export function unwrapOrgKey(wrapKey: Uint8Array, wrapped: Uint8Array, orgId: string, slot: string, version = 1) {
  return open(wrapKey, wrapped, keyAad(orgId, slot, version));
}

// ---------- passkey (WebAuthn PRF) ----------

/** Fixed PRF input; the authenticator mixes it with a per-credential secret. */
export const PRF_SALT = sha256(enc.encode("zebfin/prf/v1"));

/** Each passkey gets its own wrapped copy of the org key, stored under this slot ID. */
export function passkeySlot(credentialRawId: Uint8Array): string {
  const h = sha256(new Uint8Array([...enc.encode("zebfin/slot/v1|"), ...credentialRawId]));
  return bytesToUuid(h);
}

export function passkeyWrapKey(prfOutput: Uint8Array, slot: string): Uint8Array {
  return hkdf(sha256, prfOutput, enc.encode(slot), enc.encode("zebfin/wrap/v1"), 32);
}

// ---------- approver spending keys ----------

// An approver's seed is wrapped under *their own* passkey, not the org key, so
// other members (who all hold the org key) can't sign. One slot per
// (passkey, account).

export function spendSlot(credentialRawId: Uint8Array, accountId: string): string {
  const h = sha256(new Uint8Array([...enc.encode(`zebfin/spend-slot/v1|${accountId}|`), ...credentialRawId]));
  return bytesToUuid(h);
}

export function spendWrapKey(prfOutput: Uint8Array, slot: string): Uint8Array {
  return hkdf(sha256, prfOutput, enc.encode(slot), enc.encode("zebfin/spendwrap/v1"), 32);
}

const seedAad = (orgId: string, slot: string) => `zebfin/seed/v1|${orgId}|${slot}`;

export interface SeedPayload {
  mnemonic: string;
  accountIndex: number;
}

export function wrapSeed(wrapKey: Uint8Array, seed: SeedPayload, orgId: string, slot: string): Uint8Array {
  return seal(wrapKey, pad(enc.encode(JSON.stringify(seed))), seedAad(orgId, slot));
}

export function unwrapSeed(wrapKey: Uint8Array, sealed: Uint8Array, orgId: string, slot: string): SeedPayload {
  return JSON.parse(dec.decode(unpad(open(wrapKey, sealed, seedAad(orgId, slot)))));
}

// ---------- invites ----------

// An invite link is /join#<inviteId>.<secret>. The fragment never reaches the
// server; from the secret the browser derives where the invite's wrapped org
// key is stored, the key that unwraps it, and a verifier whose hash the server
// checks before letting the invitee register a passkey.

export interface InviteMaterial {
  slot: string;
  wrapKey: Uint8Array;
  verifier: Uint8Array;
}

export function inviteMaterial(secret: Uint8Array): InviteMaterial {
  const d = (info: string) => hkdf(sha256, secret, undefined, enc.encode(info), 32);
  return {
    slot: bytesToUuid(d("zebfin/invite/slot/v1")),
    wrapKey: d("zebfin/invite/wrap/v1"),
    verifier: d("zebfin/invite/verify/v1"),
  };
}

// ---------- contributor portals ----------

// A portal link is /contribute#<portalId>.<secret>. The secret yields the key
// for everything shared with that one contributor, and a verifier the server
// checks. Contributors never see the org key.

export function portalMaterial(secret: Uint8Array): { key: Uint8Array; verifier: Uint8Array } {
  const d = (info: string) => hkdf(sha256, secret, undefined, enc.encode(info), 32);
  return { key: d("zebfin/portal/key/v1"), verifier: d("zebfin/portal/verify/v1") };
}

export const portalAad = (portalId: string, part: string) => `zebfin/portal/v1|${portalId}|${part}`;

// ---------- personal key and sealed boxes ----------

/**
 * A key only this member's passkey can produce (derived from the PRF output),
 * for data even teammates holding the org key mustn't read, like the amounts
 * of kudos you gave. Per passkey: a second device derives a different key.
 */
export function personalKey(prfOutput: Uint8Array, slot: string): Uint8Array {
  return hkdf(sha256, prfOutput, enc.encode(slot), enc.encode("zebfin/personal/v1"), 32);
}

export function sealPersonal(key: Uint8Array, value: unknown, aad: string): string {
  return toB64(encryptJson(key, `zebfin/personal/v1|${aad}`, value));
}

export function openPersonal<T>(key: Uint8Array, sealed: string, aad: string): T {
  return decryptJson<T>(key, `zebfin/personal/v1|${aad}`, fromB64(sealed));
}

export function newBoxKeypair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = x25519.utils.randomPrivateKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** Anonymous sealed box (X25519 + XChaCha20-Poly1305): only the holder of `publicKey`'s secret can open it. */
export function sealTo(publicKey: Uint8Array, value: unknown, aad: string): string {
  const eph = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(eph);
  const shared = x25519.getSharedSecret(eph, publicKey);
  const key = hkdf(sha256, shared, new Uint8Array([...ephPub, ...publicKey]), enc.encode("zebfin/box/v1"), 32);
  const ct = encryptJson(key, `zebfin/box/v1|${aad}`, value);
  return toB64(new Uint8Array([...ephPub, ...ct]));
}

export function openSealed<T>(secretKey: Uint8Array, sealed: string, aad: string): T {
  const bytes = fromB64(sealed);
  const ephPub = bytes.slice(0, 32);
  const publicKey = x25519.getPublicKey(secretKey);
  const shared = x25519.getSharedSecret(secretKey, ephPub);
  const key = hkdf(sha256, shared, new Uint8Array([...ephPub, ...publicKey]), enc.encode("zebfin/box/v1"), 32);
  return decryptJson<T>(key, `zebfin/box/v1|${aad}`, bytes.slice(32));
}

// ---------- recovery kit ----------

export interface RecoveryMaterial {
  slot: string;
  wrapKey: Uint8Array;
  lookupId: Uint8Array;
  verifier: Uint8Array;
}

export function newRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  return validateMnemonic(normalizePhrase(phrase), wordlist);
}

function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

/** Everything the recovery phrase unlocks, derived with domain-separated HKDF. */
export function recoveryMaterial(phrase: string): RecoveryMaterial {
  const entropy = mnemonicToEntropy(normalizePhrase(phrase), wordlist);
  const d = (info: string) => hkdf(sha256, entropy, undefined, enc.encode(info), 32);
  return {
    slot: bytesToUuid(d("zebfin/recovery/slot/v1")),
    wrapKey: d("zebfin/recovery/wrap/v1"),
    lookupId: d("zebfin/recovery/lookup/v1"),
    verifier: d("zebfin/recovery/verify/v1"),
  };
}
