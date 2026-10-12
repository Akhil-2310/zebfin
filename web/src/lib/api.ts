// Thin client for zebfin-server. Binary fields are base64 strings.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...rest.headers,
    },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const post = <T>(path: string, body: unknown, token?: string) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body), token });

export const put = <T>(path: string, body: unknown, token?: string) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body), token });

// ---------- response types ----------

export interface SessionResponse {
  org_id: string;
  member_id: string;
  token: string;
}

export interface StartResponse {
  challenge_id: string;
  org_id: string | null;
  member_id: string | null;
  options: unknown;
}

export interface WrappedKey {
  member_id: string; // a key slot: one per passkey, plus the recovery kit
  key_version: number;
  ciphertext: string;
}

export interface EncRecord {
  id: string;
  ciphertext: string;
  updated_at: string;
}

export interface Balance {
  chain_tip: number;
  fully_scanned: number | null;
  total_zats: number;
  orchard_spendable_zats: number;
  ironwood_spendable_zats: number;
  pending_zats: number;
}

export interface HistoryEntry {
  txid: string;
  mined_height: number | null;
  pool: string;
  direction: "sent" | "received" | "internal";
  value_zats: number;
  is_change: boolean;
  memo: string | null;
}

export interface PcztSummary {
  orchard_actions: number;
  ironwood_actions: number;
  spent_zats: number;
  payments: { pool: string; address: string | null; value_zats: number }[];
  change_zats: number;
  fee_zats: number;
  expiry_height: number;
}

export type PaymentStatus =
  | "pending_approval"
  | "approved"
  | "proving"
  | "awaiting_signature"
  | "scheduled"
  | "sending"
  | "broadcast"
  | "mined"
  | "failed"
  | "cancelled";

export interface RequestRecipient {
  address: string;
  value_zats: number;
  memo: string | null;
}

export interface Payment {
  id: string;
  account_id: string;
  kind: "payroll" | "payment" | "refund" | "transfer";
  status: PaymentStatus;
  txid: string | null;
  mined_height: number | null;
  error: string | null;
  created_at: string;
  requested_by: string | null;
  broadcast_at: string | null;
  content_hash: string;
  request: {
    recipients: RequestRecipient[];
    kind: string;
    usd_per_zec: number | null;
    usd_value: number | null;
    created_at: string;
  } | null;
  summary: PcztSummary | null;
  pczt: string | null;
  approvals: { member_id: string; created_at: string }[];
  approvals_required: number;
}

export interface Policy {
  tiers: { above_usd: number; approvals: number }[];
  daily_cap_usd: number | null;
  monthly_cap_usd: number | null;
  new_payee_hold_above_usd: number;
  new_payee_hold_hours: number;
}

export interface PolicyView {
  policy: Policy;
  pending: Policy | null;
  pending_by: string | null;
}

export interface ServerPayee {
  address_hash: string;
  added_at: string;
}

export type Role = "admin" | "approver" | "member";

export interface MembersResponse {
  members: { member_id: string; role: Role; is_me: boolean; created_at: string }[];
  approval_threshold: number;
}

export interface RateQuote {
  usd_per_zec: number;
  sources: { name: string; usd_per_zec: number }[];
  fetched_at: string;
  note: string;
}
