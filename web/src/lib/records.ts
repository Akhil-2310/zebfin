// Typed, encrypted app records. The record type lives inside the ciphertext,
// so the server sees only same-sized opaque blobs.

import { api, put, type EncRecord } from "./api";
import { decryptJson, encryptJson, fromB64, newId, recordAad, toB64 } from "./crypto";
import type { AuctionResults, AuctionRules } from "./auction";
import type { Invoice } from "./invoices";
import type { PayrollSchedule } from "./schedule";
import type { WorkspaceSettings } from "./workspace";
import type { Session } from "./session";

export interface Contributor {
  type: "contributor";
  name: string;
  role: string;
  /** Empty until the contributor submits it through their portal. */
  address: string;
  /** Private channel to this contributor (address submission, payslips). */
  portalId?: string;
  portalSecret?: string;
  /** Monthly pay in TAZ, used when payCurrency is "TAZ" (or unset). */
  monthlyTaz: number;
  /** "USD": paid monthlyUsd converted at the run's locked ZEC/USD rate. */
  payCurrency?: "USD" | "TAZ";
  monthlyUsd?: number;
}

export interface AccountLabel {
  type: "account";
  accountId: string;
  name: string;
  /** Lets an approver check a pasted seed matches this account before storing it. */
  seedFingerprint?: string;
  /** ZIP 32 account index within that seed (separate accounts per purpose). */
  accountIndex?: number;
}

export interface MemberLabel {
  type: "member";
  memberId: string;
  name: string;
  /** Where this member receives kudos (a fresh shielded address they chose). */
  payoutAddress?: string;
  /** Still receives kudos, but isn't shown on leaderboards. */
  hideFromLeaderboards?: boolean;
}

/** A payroll run's locked pricing, so approvers can check the rate hasn't moved. */
export interface RunRecord {
  type: "run";
  /** Defaults to payroll. */
  kind?: "payroll" | "kudos";
  paymentId: string;
  period: string;
  ref: string;
  usdPerZec: number | null;
  lockedAt: string;
}

/** Accountant's override for one transaction. */
export interface LedgerNote {
  type: "ledger-note";
  txid: string;
  category?: string;
  note?: string;
}

/** Auto-categorization: memo contains / recipient address equals → category. */
export interface LedgerRule {
  type: "rule";
  match: "memo" | "address";
  value: string;
  category: string;
}

/** A reviewed month; edits to it need an admin to reopen it first. */
export interface PeriodClose {
  type: "period-close";
  month: string;
  closedAt: string;
  closedBy: string;
}

/** Append-only trail of changes to the books. */
export interface AuditEvent {
  type: "audit";
  at: string;
  by: string;
  action: string;
  detail: string;
}

/** A labelled payee; the server only holds a salted hash of the address. */
export interface PayeeRecord {
  type: "payee";
  address: string;
  label: string;
}

/** Why a payment was requested, and to whom (encrypted). */
export interface RequestNote {
  type: "request-note";
  paymentId: string;
  reason: string;
  payeeLabel: string;
}

/** An expiring audit link the org has shared (so admins can see and revoke it). */
export interface AuditShare {
  type: "audit-share";
  portalId: string;
  link: string;
  accountName: string;
  scope: string;
  includesViewingKey: boolean;
  createdAt: string;
  expiresAt: string;
}

/** Program settings. Amounts are sealed to the settler's public key. */
export interface KudosSettings {
  type: "kudos-settings";
  monthlyAllowanceUsd: number;
  perRecipientCapUsd: number;
  tags: string[];
  accountId: string;
  settlerMemberId: string;
  /** X25519 public key (base64) that kudos amounts are sealed to. */
  settlementPublicKey: string;
  /** The matching secret key, sealed under the settler's passkey-derived key. */
  settlementSecretSealed: string;
}

/** A thank-you. Everyone sees who, note and tag; the amount is sealed. */
export interface Kudos {
  type: "kudos";
  from: string;
  to: string;
  note: string;
  tag: string;
  month: string;
  at: string;
  /** USD amount sealed to the settlement key (only the settler can open it). */
  amountForSettler: string;
  /** The same amount under the giver's personal key, for their allowance. */
  amountForGiver: string;
}

export interface KudosReaction {
  type: "kudos-reaction";
  kudosId: string;
  by: string;
  emoji: string;
}

export interface KudosSettlement {
  type: "kudos-settlement";
  month: string;
  paymentId: string;
  at: string;
  recipients: number;
}

/** A sealed-bid auction run from its own account. */
export interface AuctionRecord {
  type: "auction";
  rules: AuctionRules;
  accountId: string;
  portalId: string;
  portalSecret: string;
  results?: AuctionResults;
}

export type AppRecord =
  | Contributor
  | AccountLabel
  | MemberLabel
  | RunRecord
  | LedgerNote
  | LedgerRule
  | PeriodClose
  | AuditEvent
  | PayeeRecord
  | RequestNote
  | Invoice
  | AuditShare
  | KudosSettings
  | Kudos
  | KudosReaction
  | KudosSettlement
  | AuctionRecord
  | PayrollSchedule
  | WorkspaceSettings;

export interface Stored<T extends AppRecord = AppRecord> {
  id: string;
  value: T;
  ciphertextBytes: number;
  ciphertextPreview: string;
}

export async function loadRecords(s: Session): Promise<Stored[]> {
  const rows = await api<EncRecord[]>("/v1/records", { token: s.token });
  const out: Stored[] = [];
  for (const r of rows) {
    const bytes = fromB64(r.ciphertext);
    try {
      out.push({
        id: r.id,
        value: decryptJson<AppRecord>(s.orgKey, recordAad(s.orgId, r.id), bytes),
        ciphertextBytes: bytes.length,
        ciphertextPreview: r.ciphertext.slice(0, 48),
      });
    } catch {
      // Not decryptable with this key (e.g. written under a rotated key).
    }
  }
  return out;
}

export async function saveRecord(s: Session, value: AppRecord, id: string = newId()): Promise<string> {
  const ct = encryptJson(s.orgKey, recordAad(s.orgId, id), value);
  await put(`/v1/records/${id}`, { ciphertext: toB64(ct) }, s.token);
  return id;
}

export async function deleteRecord(s: Session, id: string): Promise<void> {
  await api(`/v1/records/${id}`, { method: "DELETE", token: s.token });
}

export const ofType = <K extends AppRecord["type"]>(records: Stored[], type: K) =>
  records.filter((r) => r.value.type === type) as Stored<Extract<AppRecord, { type: K }>>[];

export const ZATS_PER_TAZ = 100_000_000;
export const formatTaz = (zats: number) =>
  (zats / ZATS_PER_TAZ).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 8 });
