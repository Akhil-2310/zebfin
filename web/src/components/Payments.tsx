"use client";

import { sha256 } from "@noble/hashes/sha2";
import { useCallback, useEffect, useState } from "react";
import { PaymentCard, STATUS_LABEL } from "@/components/PaymentCard";
import { api, post, type Payment, type PolicyView, type RateQuote, type ServerPayee } from "@/lib/api";
import { toB64 } from "@/lib/crypto";
import {
  ZATS_PER_TAZ,
  deleteRecord,
  formatTaz,
  saveRecord,
  type AccountLabel,
  type MemberLabel,
  type PayeeRecord,
  type RequestNote,
  type Stored,
} from "@/lib/records";
import type { Session } from "@/lib/session";
import { validateAddress } from "@/lib/signer";

/** Same salted hash the server uses, so we can match its payee list locally. */
const payeeHash = (address: string) => toB64(sha256(new TextEncoder().encode(`zebfin/payee/v1|${address.trim()}`)));

const when = (d: Date) => d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function Payments({
  session,
  accountId,
  accounts,
  accountLabels,
  payees,
  notes,
  memberLabels,
  onChanged,
}: {
  session: Session;
  accountId: string;
  accounts: string[];
  accountLabels: Stored<AccountLabel>[];
  payees: Stored<PayeeRecord>[];
  notes: Stored<RequestNote>[];
  memberLabels: Stored<MemberLabel>[];
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"pay" | "move">("pay");
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("5.00");
  const [currency, setCurrency] = useState<"USD" | "TAZ">("USD");
  const [reason, setReason] = useState("");
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [active, setActive] = useState<Payment | null>(null);
  const [quote, setQuote] = useState<RateQuote | null>(null);
  const [serverPayees, setServerPayees] = useState<ServerPayee[]>([]);
  const [policy, setPolicy] = useState<PolicyView | null>(null);

  const nameOfAccount = (id: string) => accountLabels.find((l) => l.value.accountId === id)?.value.name ?? "Account";

  const refresh = useCallback(() => {
    Promise.all([
      api<Payment[]>(`/v1/accounts/${accountId}/payments`, { token: session.token }),
      api<ServerPayee[]>("/v1/payees", { token: session.token }),
      api<PolicyView>("/v1/policy", { token: session.token }),
      api<RateQuote>("/v1/rates/zec-usd", { token: session.token }).catch(() => null),
    ]).then(
      ([ps, sp, pol, q]) => {
        setPayments(ps.filter((p) => p.kind !== "payroll"));
        setServerPayees(sp);
        setPolicy(pol);
        setQuote(q);
      },
      () => {},
    );
  }, [accountId, session.token]);

  useEffect(() => {
    const t = setTimeout(refresh, 0);
    return () => clearTimeout(t);
  }, [refresh]);

  const onUpdate = useCallback(
    (p: Payment) => {
      setActive(p);
      refresh();
    },
    [refresh],
  );

  const rate = quote?.usd_per_zec ?? null;
  const zats = currency === "TAZ" ? Math.round(Number(amount) * ZATS_PER_TAZ) : rate ? Math.round((Number(amount) / rate) * ZATS_PER_TAZ) : null;
  const added = (address: string) => serverPayees.find((p) => p.address_hash === payeeHash(address))?.added_at ?? null;
  const holdUntil = (address: string) => {
    const at = added(address);
    return at && policy ? new Date(Date.parse(at) + policy.policy.new_payee_hold_hours * 3600_000) : null;
  };
  // The new-payee safety check, for the payee picked right now.
  const picked = payees.find((p) => p.id === payee);
  const pickedUntil = picked ? holdUntil(picked.value.address) : null;
  const pickedNew = !!pickedUntil && pickedUntil > new Date();
  const holdAbove = policy?.policy.new_payee_hold_above_usd ?? 0;
  const usd = currency === "USD" ? Number(amount) : rate ? Number(amount) * rate : null;
  const willHold = pickedNew && usd !== null && usd > holdAbove;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!zats || zats <= 0) throw new Error("Enter an amount (and wait for the ZEC/USD rate for USD amounts).");
      let p: Payment;
      let label: string;
      if (mode === "move") {
        if (!dest) throw new Error("Pick the account to move funds to.");
        // A fresh address of our own destination account.
        const { address } = await post<{ address: string }>(`/v1/accounts/${dest}/addresses`, {}, session.token);
        p = await post<Payment>(
          `/v1/accounts/${accountId}/payments`,
          { kind: "transfer", recipients: [{ address, value_zats: zats, memo: `Zebfin transfer to ${nameOfAccount(dest)}` }] },
          session.token,
        );
        label = `Transfer to ${nameOfAccount(dest)}`;
      } else {
        const record = payees.find((x) => x.id === payee);
        if (!record) throw new Error("Pick a payee.");
        p = await post<Payment>(
          `/v1/accounts/${accountId}/payments`,
          { kind: "payment", recipients: [{ address: record.value.address, value_zats: zats, memo: reason || null }] },
          session.token,
        );
        label = record.value.label;
      }
      await saveRecord(session, { type: "request-note", paymentId: p.id, reason, payeeLabel: label });
      setActive(p);
      setReason("");
      refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const others = accounts.filter((a) => a !== accountId);

  return (
    <section className="card">
      <h2 className="text-lg font-semibold">Payments</h2>
      <p className="mt-1 text-sm text-muted">
        Anyone on the team can request a payment. It goes out only after the approvals your policy requires, signed on an
        approver&apos;s device.
      </p>

      <form onSubmit={submit} className="mt-4 space-y-3">
        <div className="seg">
          {(
            [
              ["pay", "Pay someone"],
              ["move", "Move between accounts"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              disabled={m === "move" && others.length === 0}
              className={`${mode === m ? "seg-on" : ""} disabled:opacity-40`}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "pay" ? (
          <select className="input" value={payee} onChange={(e) => setPayee(e.target.value)} required>
            <option value="">Choose a payee…</option>
            {payees.map((p) => {
              const until = holdUntil(p.value.address);
              const held = until && until > new Date();
              return (
                <option key={p.id} value={p.id}>
                  {p.value.label}
                  {held ? " · 🛡️ new payee" : ""}
                </option>
              );
            })}
          </select>
        ) : (
          <select className="input" value={dest} onChange={(e) => setDest(e.target.value)} required>
            <option value="">Move to…</option>
            {others.map((a) => (
              <option key={a} value={a}>
                {nameOfAccount(a)}
              </option>
            ))}
          </select>
        )}
        <div className="flex gap-2">
          <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <select className="input w-auto" value={currency} onChange={(e) => setCurrency(e.target.value as "USD" | "TAZ")}>
            <option>USD</option>
            <option>TAZ</option>
          </select>
        </div>
        {mode === "pay" && pickedNew && (
          <div className="well p-3 text-sm" style={{ background: "var(--sun)", color: "#2a2036" }}>
            <p>
              <b>🛡️ New payee safety check.</b> {picked!.value.label} was added less than {policy!.policy.new_payee_hold_hours}{" "}
              hours ago, so payments over ${holdAbove.toLocaleString()} to them wait until {when(pickedUntil!)}. Smaller payments go out
              normally.
            </p>
            <p className="mt-1 text-xs">
              {willHold
                ? `This payment is over $${holdAbove.toLocaleString()}, so it will be held until then.`
                : "This payment is under the limit, so it isn\u2019t held."}{" "}
              It protects you if a payee&apos;s address was mistyped or swapped. Admins can change it in Spending policy.
            </p>
          </div>
        )}
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={mode === "pay" ? "Reason / memo (e.g. Invoice 42, hosting)" : "Reason"}
          maxLength={400}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted">
            {zats ? `${formatTaz(zats)} TAZ` : "—"}
            {mode === "pay" && " · the memo is readable only by the payee"}
          </span>
          <button className="btn" disabled={busy}>
            {busy ? "Requesting…" : "Request payment"}
          </button>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </form>

      {active && (
        <div className="mt-5">
          <PaymentCard
            session={session}
            payment={active}
            onUpdate={onUpdate}
            memberLabels={memberLabels}
            title={notes.find((n) => n.value.paymentId === active.id)?.value.payeeLabel}
          />
        </div>
      )}

      {payments.length > 0 && (
        <ul className="mt-5 divide-y divide-border text-sm">
          {payments.map((p) => {
            const note = notes.find((n) => n.value.paymentId === p.id)?.value;
            return (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <button
                  className="min-w-0 text-left hover:underline"
                  onClick={async () => setActive(await api<Payment>(`/v1/payments/${p.id}`, { token: session.token }))}
                >
                  {note?.payeeLabel ?? p.kind}
                  {note?.reason && <span className="text-muted"> · {note.reason}</span>}
                </button>
                <span className={p.status === "mined" ? "text-ok" : p.status === "failed" ? "text-danger" : "text-muted"}>
                  {STATUS_LABEL[p.status]}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <PayeeBook session={session} payees={payees} added={added} holdUntil={holdUntil} onChanged={() => (refresh(), onChanged())} />
    </section>
  );
}

function PayeeBook({
  session,
  payees,
  added,
  holdUntil,
  onChanged,
}: {
  session: Session;
  payees: Stored<PayeeRecord>[];
  added: (address: string) => string | null;
  holdUntil: (address: string) => Date | null;
  onChanged: () => void;
}) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const problem = await validateAddress(address);
      if (problem) throw new Error(problem);
      await post("/v1/payees", { address: address.trim() }, session.token);
      await saveRecord(session, { type: "payee", address: address.trim(), label: label.trim() });
      setLabel("");
      setAddress("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <details className="mt-5">
      <summary className="cursor-pointer text-sm font-semibold">Payee book ({payees.length})</summary>
      <p className="mt-1 text-xs text-muted">
        Labels are encrypted; the server keeps only a salted hash of each address. New payees pass a safety check: large
        payments to them wait for a while after they&apos;re added, in case an address was mistyped or swapped.
      </p>
      <ul className="mt-2 divide-y divide-border text-sm">
        {payees.map((p) => {
          const until = holdUntil(p.value.address);
          const inBook = added(p.value.address);
          return (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p>{p.value.label}</p>
                <p className="mono text-muted">{p.value.address.slice(0, 28)}…</p>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className={until && until > new Date() ? "text-accent-ink" : "text-muted"}>
                  {!inBook
                    ? "not registered"
                    : until && until > new Date()
                      ? `🛡️ new · large payments wait until ${when(until)}`
                      : "✓ trusted"}
                </span>
                <button
                  className="text-muted hover:text-danger"
                  onClick={async () => {
                    try {
                      await api("/v1/payees", { method: "DELETE", body: JSON.stringify({ address: p.value.address }), token: session.token });
                    } catch {}
                    await deleteRecord(session, p.id);
                    onChanged();
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <form onSubmit={add} className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" required />
        <input className="input mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="utest1…" required />
        <button className="btn">Add payee</button>
      </form>
      {error && <p className="mt-1 text-sm text-danger">{error}</p>}
    </details>
  );
}
