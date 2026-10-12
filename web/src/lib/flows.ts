// Sign-up, login and recovery. Each flow ends with the org key in memory and
// nothing but ciphertext having left the browser.

import { api, post, put, type SessionResponse, type StartResponse, type WrappedKey } from "./api";
import {
  api as apiCall,
} from "./api";
import { saveRecord } from "./records";
import {
  decryptJson,
  inviteMaterial,
  randomBytes,
  toB64Url,
  encryptJson,
  fromB64,
  metaAad,
  newOrgKey,
  newRecoveryPhrase,
  passkeySlot,
  passkeyWrapKey,
  personalKey,
  recoveryMaterial,
  toB64,
  unwrapOrgKey,
  wrapOrgKey,
} from "./crypto";
import { createPasskey, getPasskey, prfForNewPasskey } from "./passkey";
import type { Session } from "./session";

export interface OrgMeta {
  name: string;
}

async function storePasskeyWrap(session: SessionResponse, orgKey: Uint8Array, rawId: Uint8Array, prf: Uint8Array) {
  const slot = passkeySlot(rawId);
  const wrapped = wrapOrgKey(passkeyWrapKey(prf, slot), orgKey, session.org_id, slot);
  await put(`/v1/keys/${slot}/1`, { ciphertext: toB64(wrapped) }, session.token);
}

async function storeRecoveryKit(session: SessionResponse, orgKey: Uint8Array): Promise<string> {
  const phrase = newRecoveryPhrase();
  const m = recoveryMaterial(phrase);
  const wrapped = wrapOrgKey(m.wrapKey, orgKey, session.org_id, m.slot);
  await put(`/v1/keys/${m.slot}/1`, { ciphertext: toB64(wrapped) }, session.token);
  await put("/v1/recovery", { lookup_id: toB64(m.lookupId), verifier: toB64(m.verifier) }, session.token);
  return phrase;
}

/** Creates an org, its first admin passkey and a recovery kit. Returns the recovery phrase. */
export async function signup(orgName: string, yourName: string): Promise<{ session: Session; recoveryPhrase: string }> {
  const start = await post<StartResponse>("/v1/signup/start", {});
  const orgId = start.org_id!;
  const created = await createPasskey(start.options, `${orgName} · Zebfin`);

  const orgKey = newOrgKey();
  const meta: OrgMeta = { name: orgName };
  const s = await post<SessionResponse>("/v1/signup/finish", {
    challenge_id: start.challenge_id,
    credential: created.credential,
    meta_ciphertext: toB64(encryptJson(orgKey, metaAad(orgId), meta)),
  });

  const prf = await prfForNewPasskey(created);
  await storePasskeyWrap(s, orgKey, created.rawId, prf);
  const recoveryPhrase = await storeRecoveryKit(s, orgKey);
  const session: Session = {
    token: s.token,
    orgId: s.org_id,
    memberId: s.member_id,
    orgKey,
    orgName,
    passkeyRawId: created.rawId,
    personalKey: personalKey(prf, passkeySlot(created.rawId)),
  };
  await saveRecord(session, { type: "member", memberId: s.member_id, name: yourName });
  return { session, recoveryPhrase };
}

async function finishUnlock(
  s: SessionResponse,
  slot: string,
  wrapKey: Uint8Array,
  passkeyRawId: Uint8Array,
  personal: Uint8Array,
): Promise<Session> {
  const keys = await api<WrappedKey[]>("/v1/keys", { token: s.token });
  const mine = keys.filter((k) => k.member_id === slot).sort((a, b) => b.key_version - a.key_version)[0];
  if (!mine) throw new Error("No key for this passkey. Use your recovery kit, then add this passkey again.");
  const orgKey = unwrapOrgKey(wrapKey, fromB64(mine.ciphertext), s.org_id, slot, mine.key_version);
  const org = await api<{ meta_ciphertext: string }>("/v1/org", { token: s.token });
  const meta = decryptJson<OrgMeta>(orgKey, metaAad(s.org_id), fromB64(org.meta_ciphertext));
  return { token: s.token, orgId: s.org_id, memberId: s.member_id, orgKey, orgName: meta.name, passkeyRawId, personalKey: personal };
}

/** Usernameless passkey login: one signature both authenticates and unlocks the org key. */
export async function login(): Promise<Session> {
  const start = await post<StartResponse>("/v1/login/start", {});
  const a = await getPasskey(start.options);
  const s = await post<SessionResponse>("/v1/login/finish", {
    challenge_id: start.challenge_id,
    credential: a.credential,
  });
  const slot = passkeySlot(a.rawId);
  return finishUnlock(s, slot, passkeyWrapKey(a.prf, slot), a.rawId, personalKey(a.prf, slot));
}

/** Logs in with the recovery phrase and registers a new passkey on this device. */
export async function recover(phrase: string): Promise<Session> {
  const m = recoveryMaterial(phrase);
  const s = await post<SessionResponse>("/v1/recovery/login", {
    lookup_id: toB64(m.lookupId),
    verifier: toB64(m.verifier),
  });
  // The recovery session gets a new passkey below; until then no passkey is bound.
  const session = await finishUnlock(s, m.slot, m.wrapKey, new Uint8Array(), new Uint8Array());

  const start = await post<StartResponse>("/v1/passkeys/start", {}, s.token);
  const created = await createPasskey(start.options, `${session.orgName} · Zebfin`);
  await post("/v1/passkeys/finish", { challenge_id: start.challenge_id, credential: created.credential }, s.token);
  const prf = await prfForNewPasskey(created);
  await storePasskeyWrap(s, session.orgKey, created.rawId, prf);
  return { ...session, passkeyRawId: created.rawId, personalKey: personalKey(prf, passkeySlot(created.rawId)) };
}

/** Creates a single-use invite link. The org key is wrapped under a secret that exists only in the link. */
export async function createInvite(session: Session, role: string): Promise<string> {
  const secret = randomBytes(32);
  const m = inviteMaterial(secret);
  const wrapped = wrapOrgKey(m.wrapKey, session.orgKey, session.orgId, m.slot);
  await put(`/v1/keys/${m.slot}/1`, { ciphertext: toB64(wrapped) }, session.token);
  const { invite_id } = await post<{ invite_id: string }>(
    "/v1/invites",
    { role, verifier: toB64(m.verifier) },
    session.token,
  );
  return `${window.location.origin}/join#${invite_id}.${toB64Url(secret)}`;
}

/** Redeems an invite: new passkey, then the org key moves from the invite slot to it. */
export async function joinWithInvite(fragment: string, yourName: string): Promise<Session> {
  const [inviteId, secretB64] = fragment.replace(/^#/, "").split(".");
  if (!inviteId || !secretB64) throw new Error("This invite link is incomplete.");
  const m = inviteMaterial(fromB64(secretB64));

  const start = await post<StartResponse>(`/v1/invites/${inviteId}/start`, { verifier: toB64(m.verifier) });
  const created = await createPasskey(start.options, "Zebfin");
  const s = await post<SessionResponse>(`/v1/invites/${inviteId}/finish`, {
    challenge_id: start.challenge_id,
    credential: created.credential,
  });

  const prf = await prfForNewPasskey(created);
  const session = await finishUnlock(s, m.slot, m.wrapKey, created.rawId, personalKey(prf, passkeySlot(created.rawId)));
  await storePasskeyWrap(s, session.orgKey, created.rawId, prf);
  // The invite's copy of the org key is no longer needed.
  await apiCall(`/v1/keys/${m.slot}`, { method: "DELETE", token: s.token });
  await saveRecord(session, { type: "member", memberId: s.member_id, name: yourName });
  return session;
}

/** Approves a payment: a passkey assertion the server verifies for this member. */
export async function approvePayment(session: Session, paymentId: string) {
  const start = await post<StartResponse>(`/v1/payments/${paymentId}/approve/start`, {}, session.token);
  const a = await getPasskey(start.options);
  return post<import("./api").Payment>(
    `/v1/payments/${paymentId}/approve/finish`,
    { challenge_id: start.challenge_id, credential: a.credential },
    session.token,
  );
}
