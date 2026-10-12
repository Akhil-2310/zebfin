// Browser-side accounting. Everything here runs on decrypted data in the
// user's browser: the server supplies chain facts (per-account transactions
// from the view-only wallet) and bulk daily prices, and never computes a
// balance, total or category.

export const DEFAULT_CATEGORIES = [
  "Revenue",
  "Grants received",
  "Payroll",
  "Kudos",
  "Contractors",
  "Software",
  "Operations",
  "Network fees",
  "Transfers",
  "Uncategorized",
] as const;

// ---------- inputs ----------

export interface ChainOutput {
  direction: "sent" | "received" | "internal";
  value_zats: number;
  is_change: boolean;
  memo: string | null;
  to_address: string | null;
}

export interface ChainTx {
  txid: string;
  mined_height: number | null;
  block_time: number | null;
  delta_zats: number;
  fee_zats: number | null;
  expired_unmined: boolean;
  outputs: ChainOutput[];
}

export interface DailyPrice {
  date: string;
  usd_per_zec: number;
  disputed: boolean;
}

export interface LedgerContext {
  accounts: { id: string; name: string; txs: ChainTx[] }[];
  /** Addresses that belong to the org's own accounts' contributors etc. are looked up by name. */
  contributorsByAddress: Map<string, string>;
  /** txid -> payroll run info, from encrypted run records joined with payments. */
  payrollByTxid: Map<string, { period: string; ref: string; kind?: "payroll" | "kudos" }>;
  /** Payments the app believes were sent, to reconcile against the chain. */
  sentPayments: { id: string; txid: string; accountId: string; status: string }[];
  notes: Map<string, { category?: string; note?: string }>;
  rules: { match: "memo" | "address"; value: string; category: string }[];
  prices: Map<string, DailyPrice>;
  chainTip: number;
}

// ---------- outputs ----------

export type Direction = "in" | "out" | "transfer";

export interface LedgerEntry {
  txid: string;
  accountId: string;
  accountName: string;
  /** UTC date of the block, YYYY-MM-DD; null while unconfirmed. */
  date: string | null;
  month: string | null;
  height: number | null;
  confirmations: number;
  direction: Direction;
  /** Value moved to or from counterparties, excluding the fee. Always >= 0. */
  amountZats: number;
  feeZats: number;
  counterparty: string;
  memo: string | null;
  category: string;
  categorySource: "note" | "rule" | "payroll" | "default";
  note: string | null;
  usdPerZec: number | null;
  /** Signed USD impact: + for income, - for spending (fee included). */
  usdValue: number | null;
  flags: string[];
}

export interface Reconciliation {
  entries: LedgerEntry[];
  /** App-side payments with no matching chain transaction. */
  missingOnChain: { id: string; txid: string }[];
  /** Built transactions that expired without being mined (excluded from books). */
  expired: { txid: string; accountName: string }[];
}

const ZATS = 100_000_000;
const MIN_CONFIRMATIONS = 3;

const dateOf = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);

/** Value-carrying outputs that aren't change or padding. */
const realOutputs = (tx: ChainTx) => tx.outputs.filter((o) => !o.is_change && o.value_zats > 0);

export function buildLedger(ctx: LedgerContext): Reconciliation {
  const ownTxids = new Map<string, number>(); // txid -> number of org accounts it touches
  for (const a of ctx.accounts) for (const t of a.txs) ownTxids.set(t.txid, (ownTxids.get(t.txid) ?? 0) + 1);

  const entries: LedgerEntry[] = [];
  const expired: Reconciliation["expired"] = [];

  for (const account of ctx.accounts) {
    for (const tx of account.txs) {
      const date = dateOf(tx.block_time);
      if (!tx.mined_height) {
        if (tx.expired_unmined) {
          expired.push({ txid: tx.txid, accountName: account.name });
          continue;
        }
      }
      const fee = tx.delta_zats < 0 ? (tx.fee_zats ?? 0) : 0;
      const real = realOutputs(tx);
      const sentOut = real.filter((o) => o.direction === "sent");
      const between = (ownTxids.get(tx.txid) ?? 0) > 1;

      let direction: Direction;
      let amountZats: number;
      if (tx.delta_zats > 0) {
        direction = between ? "transfer" : "in";
        amountZats = tx.delta_zats;
      } else {
        direction = between || sentOut.length === 0 ? "transfer" : "out";
        amountZats = Math.max(0, -tx.delta_zats - fee);
      }

      const payroll = ctx.payrollByTxid.get(tx.txid);
      const names = sentOut.map((o) => (o.to_address && ctx.contributorsByAddress.get(o.to_address)) || null);
      let counterparty: string;
      if (payroll) {
        counterparty = `${payroll.kind === "kudos" ? "Kudos" : "Payroll"} ${payroll.period} · ${sentOut.length} ${sentOut.length === 1 ? "person" : "people"}`;
      } else if (direction === "in") {
        counterparty = "Incoming payment";
      } else if (direction === "transfer") {
        counterparty = "Between own accounts";
      } else {
        const known = names.filter(Boolean) as string[];
        counterparty = known.length ? known.join(", ") : `${sentOut.length} recipient${sentOut.length === 1 ? "" : "s"}`;
      }

      const memo =
        (direction === "in" ? real.find((o) => o.direction === "received" && o.memo) : sentOut.find((o) => o.memo))
          ?.memo ?? null;

      // Category: explicit note > payroll > rule > default.
      const note = ctx.notes.get(tx.txid);
      let category: string;
      let categorySource: LedgerEntry["categorySource"];
      const rule = ctx.rules.find((r) =>
        r.match === "memo"
          ? !!memo && memo.toLowerCase().includes(r.value.toLowerCase())
          : sentOut.some((o) => o.to_address === r.value),
      );
      if (note?.category) {
        category = note.category;
        categorySource = "note";
      } else if (payroll) {
        category = payroll.kind === "kudos" ? "Kudos" : "Payroll";
        categorySource = "payroll";
      } else if (rule) {
        category = rule.category;
        categorySource = "rule";
      } else {
        category = direction === "in" ? "Revenue" : direction === "transfer" ? "Transfers" : "Uncategorized";
        categorySource = "default";
      }

      const price = date ? ctx.prices.get(date) : undefined;
      const usdPerZec = price?.usd_per_zec ?? null;
      const signedZats = direction === "in" ? amountZats : direction === "out" ? -(amountZats + fee) : -fee;
      const usdValue = usdPerZec !== null ? (signedZats / ZATS) * usdPerZec : null;

      const flags: string[] = [];
      const confirmations = tx.mined_height ? Math.max(0, ctx.chainTip - tx.mined_height + 1) : 0;
      if (!tx.mined_height) flags.push("Unconfirmed");
      else if (confirmations < MIN_CONFIRMATIONS) flags.push(`${confirmations} confirmation${confirmations === 1 ? "" : "s"}`);
      if (direction === "in" && categorySource === "default") flags.push("Unmatched incoming payment: review");
      if (direction === "out" && category === "Uncategorized") flags.push("Needs a category");
      if (date && !price) flags.push("No price for this date");
      if (price?.disputed) flags.push("Price sources disagreed on this date");

      entries.push({
        txid: tx.txid,
        accountId: account.id,
        accountName: account.name,
        date,
        month: date?.slice(0, 7) ?? null,
        height: tx.mined_height,
        confirmations,
        direction,
        amountZats,
        feeZats: fee,
        counterparty,
        memo,
        category,
        categorySource,
        note: note?.note ?? null,
        usdPerZec,
        usdValue,
        flags,
      });
    }
  }

  // Internal transfers appear once per account they touch; keep both sides
  // (each account's balance moves) but they net to the fee in reports.
  entries.sort((a, b) => (b.height ?? Infinity) - (a.height ?? Infinity));

  const chainTxids = new Set(entries.map((e) => e.txid));
  const missingOnChain = ctx.sentPayments
    .filter((p) => (p.status === "broadcast" || p.status === "mined") && !chainTxids.has(p.txid))
    .map((p) => ({ id: p.id, txid: p.txid }));

  return { entries, missingOnChain, expired };
}

// ---------- reports ----------

export interface MonthRow {
  month: string;
  incomeUsd: number;
  payrollUsd: number;
  otherSpendUsd: number;
  feesUsd: number;
  netUsd: number;
  incomeZats: number;
  spendZats: number;
  feesZats: number;
}

const usdOf = (zats: number, rate: number | null) => (rate ? (zats / ZATS) * rate : 0);

export function monthly(entries: LedgerEntry[]): MonthRow[] {
  const rows = new Map<string, MonthRow>();
  for (const e of entries) {
    if (!e.month) continue;
    const r =
      rows.get(e.month) ??
      ({ month: e.month, incomeUsd: 0, payrollUsd: 0, otherSpendUsd: 0, feesUsd: 0, netUsd: 0, incomeZats: 0, spendZats: 0, feesZats: 0 } as MonthRow);
    if (e.direction === "in") {
      r.incomeUsd += usdOf(e.amountZats, e.usdPerZec);
      r.incomeZats += e.amountZats;
    } else if (e.direction === "out") {
      const usd = usdOf(e.amountZats, e.usdPerZec);
      if (e.category === "Payroll") r.payrollUsd += usd;
      else r.otherSpendUsd += usd;
      r.spendZats += e.amountZats;
    }
    r.feesUsd += usdOf(e.feeZats, e.usdPerZec);
    r.feesZats += e.feeZats;
    r.netUsd = r.incomeUsd - r.payrollUsd - r.otherSpendUsd - r.feesUsd;
    rows.set(e.month, r);
  }
  return [...rows.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/** Running ZEC balance per account-day, oldest first (confirmed entries only). */
export function balanceSeries(entries: LedgerEntry[]): { date: string; zats: number }[] {
  const byDate = new Map<string, number>();
  for (const e of entries) {
    if (!e.date) continue;
    const delta = e.direction === "in" ? e.amountZats : e.direction === "out" ? -(e.amountZats + e.feeZats) : -e.feeZats;
    byDate.set(e.date, (byDate.get(e.date) ?? 0) + delta);
  }
  let running = 0;
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, zats: (running += d) }));
}

/** Months of runway at the average monthly spend of the last `window` months. */
export function runwayMonths(balanceUsd: number, rows: MonthRow[], window = 3): number | null {
  const recent = rows.slice(0, window);
  if (!recent.length) return null;
  const burn = recent.reduce((s, r) => s + r.payrollUsd + r.otherSpendUsd + r.feesUsd, 0) / recent.length;
  return burn > 0 ? balanceUsd / burn : null;
}

/**
 * Unrealized gain on ZEC held, average-cost method: what the holdings are
 * worth now minus the USD value they had when they came in (net of what went
 * out, at its value when it went out). An approximation, not tax advice.
 */
export function unrealizedGainUsd(entries: LedgerEntry[], balanceZats: number, currentUsdPerZec: number): number {
  let basis = 0;
  for (const e of entries) {
    if (!e.date || e.usdPerZec === null) continue;
    if (e.direction === "in") basis += usdOf(e.amountZats, e.usdPerZec);
    else if (e.direction === "out") basis -= usdOf(e.amountZats + e.feeZats, e.usdPerZec);
    else basis -= usdOf(e.feeZats, e.usdPerZec);
  }
  return usdOf(balanceZats, currentUsdPerZec) - basis;
}

// ---------- exports ----------

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

const describe = (e: LedgerEntry) => `${e.category}: ${e.counterparty}${e.memo ? ` (${e.memo.slice(0, 80)})` : ""}`;
const mdy = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;

/** QuickBooks Online bank-upload 3-column format (Date, Description, Amount) in USD. */
export function quickbooksCsv(entries: LedgerEntry[]): string {
  return csv([
    ["Date", "Description", "Amount"],
    ...entries.filter((e) => e.date && e.usdValue !== null).map((e) => [mdy(e.date!), describe(e), e.usdValue!.toFixed(2)]),
  ]);
}

/** Xero bank statement import format, in USD. */
export function xeroCsv(entries: LedgerEntry[]): string {
  return csv([
    ["*Date", "*Amount", "Payee", "Description", "Reference"],
    ...entries
      .filter((e) => e.date && e.usdValue !== null)
      .map((e) => [e.date!, e.usdValue!.toFixed(2), e.counterparty, describe(e), e.txid.slice(0, 16)]),
  ]);
}

/** Full ledger with ZEC and USD columns. */
export function fullCsv(entries: LedgerEntry[]): string {
  return csv([
    ["date", "account", "direction", "category", "counterparty", "amount_zec", "fee_zec", "usd_per_zec", "usd_value", "memo", "txid", "height", "flags"],
    ...entries.map((e) => [
      e.date ?? "",
      e.accountName,
      e.direction,
      e.category,
      e.counterparty,
      (e.amountZats / ZATS).toFixed(8),
      (e.feeZats / ZATS).toFixed(8),
      e.usdPerZec?.toFixed(2) ?? "",
      e.usdValue?.toFixed(2) ?? "",
      e.memo ?? "",
      e.txid,
      e.height ?? "",
      e.flags.join("; "),
    ]),
  ]);
}
