// Contributor portals: a private, per-contributor channel. The org writes an
// invite card and payslips; the contributor writes their payout address. All
// of it is encrypted under a key that only the link (and the org's encrypted
// contributor record) holds.

import { API_URL, api, post, put } from "./api";
import { decryptJson, encryptJson, fromB64, newId, portalAad, portalMaterial, randomBytes, toB64, toB64Url } from "./crypto";
import type { Session } from "./session";

export interface PortalCard {
  orgName: string;
  contributorName: string;
  role: string;
}

export interface PortalResponse {
  address: string;
}

/** What an invoice's payer sees (encrypted under the payer link's key). */
export interface InvoiceCard {
  kind: "invoice";
  orgName: string;
  number: string;
  customer: string;
  description: string;
  usdAmount: number;
  usdPerZec: number;
  zats: number;
  address: string;
  uri: string;
  dueDate: string;
}

/** A read-only, expiring audit package for one account and period. */
export interface AuditCard {
  kind: "audit";
  orgName: string;
  accountName: string;
  scope: string;
  generatedAt: string;
  rows: import("./ledger").MonthRow[];
  entries: {
    date: string | null;
    direction: string;
    category: string;
    counterparty: string;
    memo: string | null;
    amountZats: number;
    feeZats: number;
    usdValue: number | null;
    txid: string;
  }[];
  /** Present only if the admin chose to share it; can't be revoked. */
  ufvk?: string;
}

/** What bidders see: the rules (results arrive later as a portal item). */
export interface AuctionCard {
  kind: "auction";
  orgName: string;
  rules: import("./auction").AuctionRules;
}

export interface Receipt {
  kind: "receipt";
  number: string;
  paidZats: number;
  txids: string[];
  issuedAt: string;
}

export interface Payslip {
  period: string;
  ref: string;
  amountZats: number;
  /** For USD-denominated pay: gross USD and the locked rate used. */
  grossUsd?: number;
  usdPerZec?: number;
  memo: string;
  orgName: string;
  contributorName: string;
  role: string;
  issuedAt: string;
}

interface PortalView {
  card_ciphertext: string;
  response_ciphertext: string | null;
  response_at: string | null;
  items: { id: string; ciphertext: string; created_at: string }[];
}

export function portalLink(portalId: string, secret: string) {
  return `${window.location.origin}/contribute#${portalId}.${secret}`;
}

// The card is written before the server assigns the portal ID, so it isn't
// bound to the ID. That's safe: every portal has its own secret and key, so a
// card copied into another portal won't decrypt there.
const CARD_AAD = "zebfin/portal/v1|card";

export async function createPortal(
  session: Session,
  card: PortalCard | InvoiceCard | AuditCard | AuctionCard,
  opts: { kind?: "contributor" | "invoice" | "audit" | "auction"; expiresInDays?: number } = {},
): Promise<{ portalId: string; secret: string }> {
  const secret = randomBytes(32);
  const { key, verifier } = portalMaterial(secret);
  const kind = opts.kind ?? ("kind" in card ? card.kind : "contributor");
  const { portal_id } = await post<{ portal_id: string }>(
    "/v1/portals",
    {
      verifier: toB64(verifier),
      card_ciphertext: toB64(encryptJson(key, CARD_AAD, card)),
      kind,
      expires_in_days: opts.expiresInDays ?? null,
    },
    session.token,
  );
  return { portalId: portal_id, secret: toB64Url(secret) };
}

function keyOf(secret: string) {
  return portalMaterial(fromB64(secret)).key;
}

/** Org side: the contributor's submitted address, if any. */
export async function readResponse(session: Session, portalId: string, secret: string): Promise<PortalResponse | null> {
  const v = await api<PortalView>(`/v1/portals/${portalId}`, { token: session.token });
  if (!v.response_ciphertext) return null;
  return decryptJson<PortalResponse>(keyOf(secret), portalAad(portalId, "response"), fromB64(v.response_ciphertext));
}

/** Org side: publish a payslip to the contributor's portal. */
export async function postPayslip(session: Session, portalId: string, secret: string, slip: Payslip) {
  const key = keyOf(secret);
  const itemId = newId();
  await put(
    `/v1/portals/${portalId}/items/${itemId}`,
    { ciphertext: toB64(encryptJson(key, portalAad(portalId, `item|${itemId}`), slip)) },
    session.token,
  );
}

// ---------- contributor side (no account, no org key) ----------

export interface ContributorPortal {
  portalId: string;
  card: PortalCard;
  address: string | null;
  payslips: Payslip[];
}

function fromFragment(fragment: string) {
  const [portalId, raw] = fragment.replace(/^#/, "").split(".");
  if (!portalId || !raw) throw new Error("This portal link is incomplete.");
  return { portalId, ...portalMaterial(fromB64(raw)) };
}

async function portalFetch<T>(path: string, verifier: Uint8Array, init: RequestInit = {}): Promise<T | undefined> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "x-portal-verifier": toB64(verifier), ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 404 ? "This portal link is invalid or was closed." : res.statusText);
  return res.status === 204 ? undefined : ((await res.json()) as T);
}

export async function openPortal(fragment: string): Promise<ContributorPortal> {
  const p = fromFragment(fragment);
  const v = (await portalFetch<PortalView>(`/v1/portal/${p.portalId}`, p.verifier))!;
  const card = decryptJson<PortalCard>(p.key, CARD_AAD, fromB64(v.card_ciphertext));
  const address = v.response_ciphertext
    ? decryptJson<PortalResponse>(p.key, portalAad(p.portalId, "response"), fromB64(v.response_ciphertext)).address
    : null;
  const payslips = v.items.flatMap((i) => {
    try {
      return [decryptJson<Payslip>(p.key, portalAad(p.portalId, `item|${i.id}`), fromB64(i.ciphertext))];
    } catch {
      return [];
    }
  });
  return { portalId: p.portalId, card, address, payslips };
}

export async function submitAddress(fragment: string, address: string) {
  const p = fromFragment(fragment);
  const ciphertext = toB64(encryptJson(p.key, portalAad(p.portalId, "response"), { address } satisfies PortalResponse));
  await portalFetch(`/v1/portal/${p.portalId}/response`, p.verifier, { method: "PUT", body: JSON.stringify({ ciphertext }) });
}

// ---------- invoice payer side ----------

export interface PayerPortal {
  portalId: string;
  card: InvoiceCard;
  refundAddress: string | null;
  receipts: Receipt[];
}

export async function openInvoicePortal(fragment: string): Promise<PayerPortal> {
  const p = fromFragment(fragment);
  const v = (await portalFetch<PortalView>(`/v1/portal/${p.portalId}`, p.verifier))!;
  const card = decryptJson<InvoiceCard>(p.key, CARD_AAD, fromB64(v.card_ciphertext));
  if (card.kind !== "invoice") throw new Error("This link isn't an invoice.");
  const refundAddress = v.response_ciphertext
    ? decryptJson<PortalResponse>(p.key, portalAad(p.portalId, "response"), fromB64(v.response_ciphertext)).address
    : null;
  const receipts = v.items.flatMap((i) => {
    try {
      return [decryptJson<Receipt>(p.key, portalAad(p.portalId, `item|${i.id}`), fromB64(i.ciphertext))];
    } catch {
      return [];
    }
  });
  return { portalId: p.portalId, card, refundAddress, receipts };
}

/** Org side: post an encrypted receipt to the payer's link. */
export async function postReceipt(session: Session, portalId: string, secret: string, receipt: Receipt) {
  const key = keyOf(secret);
  const itemId = newId();
  await put(
    `/v1/portals/${portalId}/items/${itemId}`,
    { ciphertext: toB64(encryptJson(key, portalAad(portalId, `item|${itemId}`), receipt)) },
    session.token,
  );
}

export function payLink(portalId: string, secret: string) {
  return `${window.location.origin}/pay#${portalId}.${secret}`;
}

// ---------- auditor side ----------

export async function openAuditPortal(fragment: string): Promise<{ card: AuditCard; expiresAt: string | null }> {
  const p = fromFragment(fragment);
  const res = await fetch(`${API_URL}/v1/portal/${p.portalId}`, { headers: { "x-portal-verifier": toB64(p.verifier) } });
  if (res.status === 403) throw new Error("This audit link has expired.");
  if (!res.ok) throw new Error("This audit link is invalid or was revoked.");
  const v = (await res.json()) as PortalView & { expires_at: string | null };
  const card = decryptJson<AuditCard>(p.key, CARD_AAD, fromB64(v.card_ciphertext));
  if (card.kind !== "audit") throw new Error("This link isn't an audit package.");
  return { card, expiresAt: v.expires_at };
}

// ---------- auction bidder side ----------

export async function openAuctionPortal(
  fragment: string,
): Promise<{ card: AuctionCard; results: import("./auction").AuctionResults | null }> {
  const p = fromFragment(fragment);
  const v = (await portalFetch<PortalView>(`/v1/portal/${p.portalId}`, p.verifier))!;
  const card = decryptJson<AuctionCard>(p.key, CARD_AAD, fromB64(v.card_ciphertext));
  if (card.kind !== "auction") throw new Error("This link isn't an auction.");
  let results: import("./auction").AuctionResults | null = null;
  for (const i of v.items) {
    try {
      const item = decryptJson<import("./auction").AuctionResults>(p.key, portalAad(p.portalId, `item|${i.id}`), fromB64(i.ciphertext));
      if (item.kind === "auction-results") results = item;
    } catch {}
  }
  return { card, results };
}

/** Org side: publish results to the bidders' link. */
export async function postAuctionResults(session: Session, portalId: string, secret: string, results: import("./auction").AuctionResults) {
  const key = keyOf(secret);
  const itemId = newId();
  await put(
    `/v1/portals/${portalId}/items/${itemId}`,
    { ciphertext: toB64(encryptJson(key, portalAad(portalId, `item|${itemId}`), results)) },
    session.token,
  );
}
