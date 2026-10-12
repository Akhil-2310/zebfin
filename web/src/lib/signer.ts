// The approver's signer, running in this browser (zebfin-signer compiled to
// Wasm). Seeds are stored wrapped under the approver's passkey and only
// unwrapped, after a passkey prompt, for the moment of signing.

import init, * as wasm from "@/wasm/signer/zebfin_signer";
import { api, put, type PcztSummary, type WrappedKey } from "./api";
import { fromB64, spendSlot, spendWrapKey, toB64, unwrapSeed, wrapSeed, type SeedPayload } from "./crypto";
import { getPasskey } from "./passkey";
import type { Session } from "./session";

let ready: Promise<unknown> | null = null;
function load() {
  ready ??= init({ module_or_path: "/signer/zebfin_signer_bg.wasm" });
  return ready;
}

export interface AccountExport {
  ufvk: string;
  seed_fingerprint: string;
  account_index: number;
}

export async function generateSeed(accountIndex = 0): Promise<AccountExport & { mnemonic: string }> {
  await load();
  return JSON.parse(wasm.generateSeed(accountIndex));
}

export async function exportAccount(mnemonic: string, accountIndex = 0): Promise<AccountExport> {
  await load();
  return JSON.parse(wasm.exportAccount(mnemonic.trim().toLowerCase().split(/\s+/).join(" "), accountIndex));
}

/** Decodes a PCZT locally. This, not the server's summary, is what approvers review. */
export async function summarizeLocally(pczt: Uint8Array): Promise<PcztSummary> {
  await load();
  return JSON.parse(wasm.summarize(pczt));
}

async function prf(session: Session): Promise<Uint8Array> {
  if (!session.passkeyRawId.length) throw new Error("Sign in with a passkey to use a signing key.");
  return (await getPasskey(null, session.passkeyRawId)).prf;
}

/** Wraps a seed under the current passkey and stores it (server sees ciphertext). */
export async function storeSigningKey(session: Session, accountId: string, seed: SeedPayload): Promise<void> {
  const slot = spendSlot(session.passkeyRawId, accountId);
  const sealed = wrapSeed(spendWrapKey(await prf(session), slot), seed, session.orgId, slot);
  await put(`/v1/keys/${slot}/1`, { ciphertext: toB64(sealed) }, session.token);
}

/** Whether this passkey holds a signing key for the account (no prompt needed). */
export async function hasSigningKey(session: Session, accountId: string): Promise<boolean> {
  if (!session.passkeyRawId.length) return false;
  const slot = spendSlot(session.passkeyRawId, accountId);
  const keys = await api<WrappedKey[]>("/v1/keys", { token: session.token });
  return keys.some((k) => k.member_id === slot);
}

/** Prompts for the passkey and returns the account's seed (caller must drop it promptly). */
export async function unwrapSeedWithPasskey(session: Session, accountId: string): Promise<SeedPayload> {
  const slot = spendSlot(session.passkeyRawId, accountId);
  const keys = await api<WrappedKey[]>("/v1/keys", { token: session.token });
  const wrapped = keys.find((k) => k.member_id === slot);
  if (!wrapped) throw new Error("This passkey has no signing key for this account.");
  return unwrapSeed(spendWrapKey(await prf(session), slot), fromB64(wrapped.ciphertext), session.orgId, slot);
}

/** Prompts for the passkey, unwraps the seed, signs, and drops the seed. */
export async function signWithPasskey(session: Session, accountId: string, pczt: Uint8Array): Promise<Uint8Array> {
  await load();
  const slot = spendSlot(session.passkeyRawId, accountId);
  const keys = await api<WrappedKey[]>("/v1/keys", { token: session.token });
  const wrapped = keys.find((k) => k.member_id === slot);
  if (!wrapped) throw new Error("This passkey has no signing key for this account.");
  const seed = unwrapSeed(spendWrapKey(await prf(session), slot), fromB64(wrapped.ciphertext), session.orgId, slot);
  return wasm.sign(seed.mnemonic, seed.accountIndex, pczt);
}

/** Full payee check (Orchard receiver, testnet) using the same Rust code as the backend. */
export async function validateAddress(address: string): Promise<string | null> {
  await load();
  try {
    wasm.validatePayee(address.trim());
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
