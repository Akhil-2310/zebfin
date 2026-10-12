"use client";

import { useCallback, useEffect, useState } from "react";
import { PaymentCard, STATUS_LABEL } from "@/components/PaymentCard";
import { api, post, type Payment, type RateQuote } from "@/lib/api";
import { newId } from "@/lib/crypto";
import { postPayslip } from "@/lib/portal";
import { ordinal, paidPeriods, payDay, type PayrollSchedule } from "@/lib/schedule";
import {
  ZATS_PER_TAZ,
  formatTaz,
  deleteRecord,
  saveRecord,
  type Contributor,
  type MemberLabel,
  type RunRecord,
  type Stored,
} from "@/lib/records";
import type { Session } from "@/lib/session";

function payslipMemo(c: Contributor, period: string, zats: number, ref: string, usdPerZec: number | null) {
  // Readable only by the recipient's wallet (and our outgoing viewing key).
  const gross =
    c.payCurrency === "USD" && usdPerZec ? ` | gross $${c.monthlyUsd?.toFixed(2)} @ $${usdPerZec.toFixed(2)}/ZEC` : "";
  return `Zebfin payslip | ${period} | ${c.name} (${c.role})${gross} | ${formatTaz(zats)} TAZ | ref ${ref}`.slice(0, 500);
}

/** Amount owed in zatoshis: fixed TAZ, or USD converted at the locked rate. */
function zatsFor(c: Contributor, usdPerZec: number | null): number | null {
  if (c.payCurrency === "USD") {
    if (!usdPerZec || !c.monthlyUsd) return null;
    return Math.round((c.monthlyUsd / usdPerZec) * ZATS_PER_TAZ);
  }
  return Math.round(c.monthlyTaz * ZATS_PER_TAZ);
}

export function Payroll({
  session,
  accountId,
  contributors,
  memberLabels,
  runs,
  schedule,
  onChanged,
}: {
  session: Session;
  accountId: string | null;
  contributors: Stored<Contributor>[];
  memberLabels: Stored<MemberLabel>[];
  runs: Stored<RunRecord>[];
  schedule: Stored<PayrollSchedule> | null;
  onChanged: () => void;
}) {
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [active, setActive] = useState<Payment | null>(null);
  const [quote, setQuote] = useState<RateQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [scheduleDay, setScheduleDay] = useState(() => Math.min(28, new Date().getDate()));
  const [now] = useState(() => new Date());

  // The server refreshes prices on its own timer; reading its cached quote
  // tells price providers nothing about when we run payroll.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<RateQuote>("/v1/rates/zec-usd", { token: session.token }).then(
        (q) => {
          if (cancelled) return;
          setQuote(q);
          setQuoteError(null);
        },
        (e) => !cancelled && setQuoteError(e instanceof Error ? e.message : String(e)),
      );
    const first = setTimeout(load, 0);
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [session.token]);

  const refresh = useCallback(() => {
    if (!accountId) return;
    api<Payment[]>(`/v1/accounts/${accountId}/payments`, { token: session.token }).then(
      (ps) => setPayments(ps.filter((p) => p.kind === "payroll")),
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

  if (!accountId) {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold">Payroll</h2>
        <p className="mt-1 text-sm text-muted">Connect a treasury account first.</p>
      </section>
    );
  }

  const rate = quote?.usd_per_zec ?? null;
  const payable = contributors.filter((c) => c.value.address);
  const selected = payable.filter((c) => picked[c.id]);
  const unpriced = selected.some((c) => zatsFor(c.value, rate) === null);
  const totalZats = selected.reduce((s, c) => s + (zatsFor(c.value, rate) ?? 0), 0);

  const dead = new Set(payments.filter((p) => p.status === "cancelled" || p.status === "failed").map((p) => p.id));
  const next = schedule ? payDay(schedule.value, paidPeriods(runs.map((r) => r.value), dead), now) : null;
  const scheduled = schedule ? payable.filter((c) => schedule.value.contributorIds.includes(c.id)) : [];
  const monthName = (period: string) =>
    new Date(`${period}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  function fillScheduledRun() {
    if (!next) return;
    setPeriod(next.period);
    setPicked(Object.fromEntries(scheduled.map((c) => [c.id, true])));
  }

  async function saveSchedule() {
    setError(null);
    try {
      // The people ticked below (or everyone payable) make up the regular run.
      const ids = (selected.length ? selected : payable).map((c) => c.id);
      await saveRecord(session, { type: "payroll-schedule", dayOfMonth: scheduleDay, contributorIds: ids }, schedule?.id);
      setEditingSchedule(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createRun() {
    setBusy(true);
    setError(null);
    try {
      const ref = `PR-${newId().slice(0, 8).toUpperCase()}`;
      // Lock the rate now: this quote prices the whole run.
      const lockedRate = selected.some((c) => c.value.payCurrency === "USD") ? rate : null;
      const recipients = selected.map((c) => {
        const zats = zatsFor(c.value, lockedRate);
        if (zats === null) throw new Error("No ZEC/USD rate available to price USD salaries.");
        return { address: c.value.address, value_zats: zats, memo: payslipMemo(c.value, period, zats, ref, lockedRate) };
      });
      const p = await post<Payment>(`/v1/accounts/${accountId}/payments`, { recipients, kind: "payroll" }, session.token);
      setActive(p);
      await saveRecord(session, {
        type: "run",
        paymentId: p.id,
        period,
        ref,
        usdPerZec: lockedRate,
        lockedAt: new Date().toISOString(),
      });
      // Each contributor's payslip also goes to their private portal.
      await Promise.all(
        selected.map((c, i) =>
          c.value.portalId && c.value.portalSecret
            ? postPayslip(session, c.value.portalId, c.value.portalSecret, {
                period,
                ref,
                amountZats: recipients[i].value_zats,
                grossUsd: c.value.payCurrency === "USD" ? c.value.monthlyUsd : undefined,
                usdPerZec: c.value.payCurrency === "USD" && lockedRate ? lockedRate : undefined,
                memo: recipients[i].memo,
                orgName: session.orgName,
                contributorName: c.value.name,
                role: c.value.role,
                issuedAt: new Date().toISOString(),
              })
            : null,
        ),
      );
      setPicked({});
      refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="text-lg font-semibold">Payroll run</h2>
      <p className="mt-1 text-sm text-muted">
        One shielded transaction pays everyone. Each person&apos;s payslip rides in an encrypted memo only they can read.
      </p>

      {payable.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Add contributors with payout addresses to run payroll.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {next?.due && scheduled.length > 0 && (
            <div className="well flex flex-wrap items-center justify-between gap-3 p-3" style={{ background: "var(--sun)", color: "#2a2036" }}>
              <p className="text-sm">
                <span className="display">💰 Pay day!</span> {monthName(next.period)} payroll is due for {scheduled.length}{" "}
                {scheduled.length === 1 ? "person" : "people"}.
              </p>
              <button className="btn-ghost px-3 py-1 text-xs" onClick={fillScheduledRun}>
                Fill in this run
              </button>
            </div>
          )}
          {editingSchedule ? (
            <div className="well space-y-2 p-3 text-sm">
              <label className="flex flex-wrap items-center gap-2">
                Pay on the
                <select className="input w-20" value={scheduleDay} onChange={(e) => setScheduleDay(Number(e.target.value))}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {ordinal(d)}
                    </option>
                  ))}
                </select>
                of each month
              </label>
              <p className="text-xs text-muted">
                The regular run is {selected.length ? `the ${selected.length} people ticked below` : `everyone below (${payable.length})`}.
                On pay day Zeb reminds approvers and fills in the run; it still needs approvals and a passkey signature to send.
              </p>
              <div className="flex gap-2">
                <button className="btn px-3 py-1 text-xs" onClick={saveSchedule}>
                  Save pay day
                </button>
                <button className="btn-ghost px-3 py-1 text-xs" onClick={() => setEditingSchedule(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : schedule && next ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                📅 Pay day: the {ordinal(schedule.value.dayOfMonth)} · {scheduled.length} {scheduled.length === 1 ? "person" : "people"}
                <span className="text-muted">
                  {next.due
                    ? ` · ${monthName(next.period)} due now`
                    : ` · next ${next.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} (in ${next.daysUntil} ${next.daysUntil === 1 ? "day" : "days"})`}
                </span>
              </span>
              <span className="flex gap-2">
                <button
                  className="text-xs text-muted hover:text-foreground"
                  onClick={() => {
                    setScheduleDay(schedule.value.dayOfMonth);
                    setPicked(Object.fromEntries(scheduled.map((c) => [c.id, true])));
                    setEditingSchedule(true);
                  }}
                >
                  Edit
                </button>
                <button
                  className="text-xs text-muted hover:text-danger"
                  onClick={async () => {
                    await deleteRecord(session, schedule.id);
                    onChanged();
                  }}
                >
                  Remove
                </button>
              </span>
            </div>
          ) : (
            <button className="text-sm text-accent-ink hover:underline" onClick={() => setEditingSchedule(true)}>
              📅 Set a regular pay day
            </button>
          )}
          <p className="text-xs text-muted">
            {quote
              ? `ZEC/USD $${quote.usd_per_zec.toFixed(2)} (${quote.sources.map((x) => x.name).join(" + ")}, ${new Date(quote.fetched_at).toLocaleTimeString()}). ${quote.note}.`
              : (quoteError ?? "Loading ZEC/USD rate…")}
          </p>
          <div className="flex items-center gap-2">
            <label className="label mb-0">Period</label>
            <input className="input w-36" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </div>
          <ul className="space-y-1 text-sm">
            {payable.map((c) => (
              <li key={c.id}>
                <label className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 hover:bg-accent-soft">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!picked[c.id]}
                      onChange={(e) => setPicked({ ...picked, [c.id]: e.target.checked })}
                    />
                    {c.value.name}
                  </span>
                  <span className="tabular-nums text-muted">
                    {c.value.payCurrency === "USD" && `$${c.value.monthlyUsd?.toFixed(2)} → `}
                    {zatsFor(c.value, rate) === null ? "needs rate" : `${formatTaz(zatsFor(c.value, rate)!)} TAZ`}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm">
              Total <span className="font-semibold tabular-nums">{formatTaz(totalZats)} TAZ</span> + network fee
            </span>
            <button className="btn" onClick={createRun} disabled={busy || selected.length === 0 || unpriced}>
              {busy ? "Creating…" : `Request run for ${selected.length}`}
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      {active && (
        <div className="mt-5">
          <PaymentCard
            session={session}
            payment={active}
            onUpdate={onUpdate}
            memberLabels={memberLabels}
            run={runs.find((r) => r.value.paymentId === active.id)?.value ?? null}
            quote={quote}
          />
        </div>
      )}

      {payments.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold">Runs</h3>
          <ul className="divide-y divide-border text-sm">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <button
                  className="text-left hover:underline"
                  onClick={async () => setActive(await api<Payment>(`/v1/payments/${p.id}`, { token: session.token }))}
                >
                  {runs.find((r) => r.value.paymentId === p.id)?.value.period ?? new Date(p.created_at).toLocaleDateString()}
                  <span className="text-muted"> · {new Date(p.created_at).toLocaleString()}</span>
                </button>
                <span className={p.status === "mined" ? "text-ok" : p.status === "failed" ? "text-danger" : "text-muted"}>
                  {STATUS_LABEL[p.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
