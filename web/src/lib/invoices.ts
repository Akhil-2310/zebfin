// Invoices: one fresh address per invoice, a ZIP 321 payment request, and
// matching of received payments by the address they arrived at.

import { toB64Url } from "./crypto";
import type { ChainTx } from "./ledger";

export interface Invoice {
  type: "invoice";
  number: string;
  customer: string;
  description: string;
  usdAmount: number;
  usdPerZec: number;
  zats: number;
  /** Fresh Orchard-only address used for this invoice alone. */
  address: string;
  dueDate: string;
  createdAt: string;
  accountId: string;
  portalId: string;
  portalSecret: string;
  receiptSentAt?: string;
  refundPaymentId?: string;
}

export type InvoiceStatus = "unpaid" | "part-paid" | "paid" | "overpaid";

/** ZIP 321 URI: amount in ZEC, memo as base64url, human-readable message. */
export function zip321Uri(address: string, zats: number, memo: string, message: string): string {
  const amount = (zats / 1e8).toFixed(8).replace(/\.?0+$/, "");
  const memo64 = toB64Url(new TextEncoder().encode(memo));
  return `zcash:${address}?amount=${amount}&memo=${memo64}&message=${encodeURIComponent(message)}`;
}

export interface InvoiceMatch {
  receivedZats: number;
  status: InvoiceStatus;
  payments: { txid: string; zats: number; height: number | null; memo: string | null }[];
}

/** Sums what arrived at the invoice's address. Only this invoice uses it. */
export function matchInvoice(invoice: Pick<Invoice, "address" | "zats">, txs: ChainTx[]): InvoiceMatch {
  const payments: InvoiceMatch["payments"] = [];
  for (const tx of txs) {
    for (const o of tx.outputs) {
      if (o.direction === "received" && !o.is_change && o.to_address === invoice.address && o.value_zats > 0) {
        payments.push({ txid: tx.txid, zats: o.value_zats, height: tx.mined_height, memo: o.memo });
      }
    }
  }
  const receivedZats = payments.reduce((s, p) => s + p.zats, 0);
  // Allow a tiny tolerance for wallets that round the requested amount.
  const tolerance = 10;
  const status: InvoiceStatus =
    receivedZats === 0
      ? "unpaid"
      : receivedZats + tolerance < invoice.zats
        ? "part-paid"
        : receivedZats > invoice.zats + tolerance
          ? "overpaid"
          : "paid";
  return { receivedZats, status, payments };
}
