// WebAuthn helpers. The server sends standard options with base64url fields;
// we convert them, add the PRF extension, and serialize the result by hand so
// that PRF outputs (in getClientExtensionResults) are never sent anywhere.

import { PRF_SALT, fromB64, randomBytes, toB64Url } from "./crypto";

/* eslint-disable @typescript-eslint/no-explicit-any */

const buf = (s: string) => fromB64(s) as BufferSource;

export class PrfUnsupportedError extends Error {
  constructor() {
    super(
      "This passkey provider doesn't support the PRF extension, which Zebfin needs to protect your keys. " +
        "Try Chrome or Safari with iCloud Keychain or Google Password Manager.",
    );
  }
}

function prfFirst(cred: PublicKeyCredential): Uint8Array | null {
  const ext = cred.getClientExtensionResults() as any;
  const first = ext?.prf?.results?.first;
  return first ? new Uint8Array(first as ArrayBuffer) : null;
}

export interface CreatedPasskey {
  credential: unknown; // JSON for the server, without extension outputs
  rawId: Uint8Array;
  prf: Uint8Array | null; // some providers only return PRF on `get`
}

/**
 * Creates a discoverable passkey. `label` is what the user's password manager
 * shows (e.g. the org name); it is set here, locally, and never sent to us.
 */
export async function createPasskey(serverOptions: any, label: string): Promise<CreatedPasskey> {
  const pk = serverOptions.publicKey;
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...pk,
    challenge: buf(pk.challenge),
    user: { id: buf(pk.user.id), name: label, displayName: label },
    excludeCredentials: (pk.excludeCredentials ?? []).map((c: any) => ({ ...c, id: buf(c.id) })),
    authenticatorSelection: {
      ...(pk.authenticatorSelection ?? {}),
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    extensions: { ...(pk.extensions ?? {}), prf: { eval: { first: PRF_SALT } } } as any,
  };
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey creation was cancelled");
  const ext = cred.getClientExtensionResults() as any;
  if (ext?.prf?.enabled === false) throw new PrfUnsupportedError();

  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    credential: {
      id: cred.id,
      rawId: toB64Url(new Uint8Array(cred.rawId)),
      type: cred.type,
      response: {
        attestationObject: toB64Url(new Uint8Array(r.attestationObject)),
        clientDataJSON: toB64Url(new Uint8Array(r.clientDataJSON)),
        transports: r.getTransports?.() ?? [],
      },
      extensions: {},
    },
    rawId: new Uint8Array(cred.rawId),
    prf: prfFirst(cred),
  };
}

export interface Assertion {
  credential: unknown;
  rawId: Uint8Array;
  prf: Uint8Array;
}

/** Signs a server login challenge (usernameless) and evaluates PRF. */
export async function getPasskey(serverOptions: any, allowRawId?: Uint8Array): Promise<Assertion> {
  const pk = serverOptions?.publicKey;
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: pk ? buf(pk.challenge) : (randomBytes(32) as BufferSource),
    rpId: pk?.rpId,
    timeout: pk?.timeout ?? 300000,
    userVerification: "required",
    allowCredentials: allowRawId
      ? [{ type: "public-key", id: allowRawId as BufferSource }]
      : (pk?.allowCredentials ?? []).map((c: any) => ({ type: "public-key", id: buf(c.id), transports: c.transports })),
    extensions: { prf: { eval: { first: PRF_SALT } } } as any,
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey sign-in was cancelled");
  const prf = prfFirst(cred);
  if (!prf) throw new PrfUnsupportedError();

  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    credential: {
      id: cred.id,
      rawId: toB64Url(new Uint8Array(cred.rawId)),
      type: cred.type,
      response: {
        authenticatorData: toB64Url(new Uint8Array(r.authenticatorData)),
        clientDataJSON: toB64Url(new Uint8Array(r.clientDataJSON)),
        signature: toB64Url(new Uint8Array(r.signature)),
        userHandle: r.userHandle ? toB64Url(new Uint8Array(r.userHandle)) : null,
      },
      extensions: {},
    },
    rawId: new Uint8Array(cred.rawId),
    prf,
  };
}

/** PRF output for a just-created passkey, via a local-only assertion (no server round trip). */
export async function prfForNewPasskey(created: CreatedPasskey): Promise<Uint8Array> {
  if (created.prf) return created.prf;
  return (await getPasskey(null, created.rawId)).prf;
}
