"use client";

import { useEffect, useState } from "react";
import { api, post, type Balance, type Payment, type PcztSummary, type RateQuote } from "@/lib/api";
import { fromB64, toB64 } from "@/lib/crypto";
import { approvePayment } from "@/lib/flows";
import { formatTaz, type MemberLabel, type RunRecord, type Stored } from "@/lib/records";
import type { Session } from "@/lib/session";
import { hasSigningKey, signWithPasskey, summarizeLocally } from "@/lib/signer";
import { PublicView } from "@/components/PublicView";

export const STATUS_LABEL: Record<Payment["status"], string> = {
  pending_approval: "Waiting for approvals",
  approved: "Approved, ready to sign",
  proving: "Preparing transaction…",
  awaiting_signature: "Ready to sign",
  scheduled: "Signed, scheduled to send",
  sending: "Sending…",
  broadcast: "Broadcast, waiting for block",
  mined: "Confirmed on-chain",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Re-pricing threshold: can't sign if ZEC moved more than this since a run was priced. */
const PRICE_BAND = 0.02;
const TERMINAL: Payment["status"][] = ["mined", "failed", "cancelled"];

/**
 * One payment request through its whole life: approvals on the request's
 * content, then building, local review and passkey signing.
 */
export function PaymentCard({
  session,
  payment,
  onUpdate,
  memberLabels,
  run,
  quote,
  title,
}: {
  session: Session;
  payment: Payment;
  onUpdate: (p: Payment) => void;
  memberLabels: Stored<MemberLabel>[];
  run?: RunRecord | null;
  quote?: RateQuote | null;
  title?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [canSign, setCanSign] = useState<boolean | null>(null);
  const [local, setLocal] = useState<PcztSummary | null>(null);
  const [tip, setTip] = useState<number | null>(null);
  const [sendNow, setSendNow] = useState(false);
  const awaiting = payment.status === "awaiting_signature" && !!payment.pczt;

  // Keep the card fresh until the payment settles.
  useEffect(() => {
    if (TERMINAL.includes(payment.status)) return;
    const t = setInterval(async () => {
      try {
        onUpdate(await api<Payment>(`/v1/payments/${payment.id}`, { token: session.token }));
      } catch {}
    }, 4000);
    return () => clearInterval(t);
  }, [payment.id, payment.status, session.token, onUpdate]);

  // Once built: decode the PCZT locally (the approver reviews this, not the
  // server's summary) and check whether this passkey can sign.
  useEffect(() => {
    if (!awaiting) return;
    let cancelled = false;
    Promise.all([
      hasSigningKey(session, payment.account_id),
      summarizeLocally(fromB64(payment.pczt!)),
      api<Balance>(`/v1/accounts/${payment.account_id}/balance`, { token: session.token }),
    ]).then(
      ([has, sum, bal]) => {
        if (cancelled) return;
        setCanSign(has);
        setLocal(sum);
        setTip(bal.chain_tip);
      },
      (err) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [awaiting, payment.account_id, payment.pczt, session]);

  async function act(fn: () => Promise<Payment | void>) {
    setBusy(true);
    setError(null);
    try {
      const p = await fn();
      if (p) onUpdate(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const approve = () => act(() => approvePayment(session, payment.id));
  const cancel = () => act(() => api<Payment>(`/v1/payments/${payment.id}`, { method: "DELETE", token: session.token }));
  const prepare = () => act(() => post<Payment>(`/v1/payments/${payment.id}/build`, {}, session.token));
  const submit = (signed: Uint8Array) =>
    post<Payment>(`/v1/payments/${payment.id}/signature`, { pczt: toB64(signed), send_now: sendNow }, session.token);
  // Passkey prompt -> unwrap seed -> sign in Wasm -> drop seed.
  const signHere = () => act(async () => submit(await signWithPasskey(session, payment.account_id, fromB64(payment.pczt!))));

  function download() {
    if (!payment.pczt) return;
    const blob = new Blob([fromB64(payment.pczt) as BlobPart], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `zebfin-${payment.id.slice(0, 8)}.created`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const iApproved = payment.approvals.some((a) => a.member_id === session.memberId);
  const approved = payment.approvals.length >= payment.approvals_required;
  const nameOf = (id: string) => memberLabels.find((m) => m.value.memberId === id)?.value.name ?? "A teammate";
  const blocksLeft = local && tip ? local.expiry_height - tip : null;
  const drift = run?.usdPerZec && quote ? Math.abs(quote.usd_per_zec - run.usdPerZec) / run.usdPerZec : 0;
  const repriceNeeded = drift > PRICE_BAND;

  // What it pays: decoded locally once built, otherwise the request.
  const lines = local
    ? local.payments.filter((p) => p.value_zats > 0).map((p) => ({ address: p.address ?? "?", value: p.value_zats }))
    : (payment.request?.recipients ?? []).map((r) => ({ address: r.address, value: r.value_zats }));
  const padding = local?.payments.filter((p) => p.value_zats === 0).length ?? 0;
  const approvable = ["pending_approval", "approved", "proving", "awaiting_signature"].includes(payment.status);

  return (
    <div className="rounded-lg border border-border p-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{title ?? STATUS_LABEL[payment.status]}</span>
        <span className="mono text-muted">
          {payment.kind} · {payment.id.slice(0, 8)}
        </span>
      </div>
      {title && <p className="text-muted">{STATUS_LABEL[payment.status]}</p>}

      <ul className="mt-2 space-y-1">
        {lines.map((l, i) => (
          <li key={i} className="flex justify-between gap-3">
            <span className="mono text-muted">{l.address.slice(0, 24)}…</span>
            <span className="tabular-nums">{formatTaz(l.value)} TAZ</span>
          </li>
        ))}
        {payment.request?.usd_value != null && (
          <li className="flex justify-between text-muted">
            <span>Value when requested</span>
            <span className="tabular-nums">${payment.request.usd_value.toFixed(2)}</span>
          </li>
        )}
        {local && (
          <>
            {padding > 0 && (
              <li className="flex justify-between text-muted">
                <span>Padding · {padding} zero-value outputs to the org&apos;s own addresses</span>
                <span>0 TAZ</span>
              </li>
            )}
            <li className="flex justify-between text-muted">
              <span>Network fee · {local.orchard_actions + local.ironwood_actions} shielded actions</span>
              <span className="tabular-nums">{formatTaz(local.fee_zats)} TAZ</span>
            </li>
          </>
        )}
      </ul>
      {local && <p className="mt-1 text-xs text-ok">Decoded on this device from the transaction itself.</p>}

      {approvable && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="font-medium">
            Approvals {payment.approvals.length} of {payment.approvals_required}
          </p>
          <ul className="text-muted">
            {payment.approvals.map((a) => (
              <li key={a.member_id}>
                ✓ {nameOf(a.member_id)}
                {a.member_id === session.memberId && " (you)"} · {new Date(a.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">
            Approvals cover this exact list of recipients, amounts and memos (content hash {payment.content_hash.slice(0, 12)}…).
          </p>
        </div>
      )}

      {run?.usdPerZec && approvable && (
        <p className={`mt-2 ${repriceNeeded ? "text-danger" : "text-muted"}`}>
          Priced at ${run.usdPerZec.toFixed(2)}/ZEC
          {quote && ` · now $${quote.usd_per_zec.toFixed(2)} (${(drift * 100).toFixed(2)}% move)`}
          {repriceNeeded && `. ZEC moved more than ${PRICE_BAND * 100}% since pricing; cancel and create the run again.`}
        </p>
      )}

      {approvable && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!iApproved && (
            <button className="btn" onClick={approve} disabled={busy}>
              {busy ? "Waiting for passkey…" : "Approve with passkey"}
            </button>
          )}
          {payment.status === "approved" && (
            <button className={iApproved ? "btn" : "btn-ghost"} onClick={prepare} disabled={busy || repriceNeeded}>
              Prepare transaction to sign
            </button>
          )}
          <button className="btn-ghost" onClick={cancel} disabled={busy}>
            Cancel
          </button>
        </div>
      )}
      {payment.status === "approved" && (
        <p className="mt-2 text-xs text-muted">
          Preparing builds and proves the transaction. It then stays valid for about 17 minutes; if it lapses, prepare
          it again (no new approvals needed).
        </p>
      )}

      {awaiting && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {blocksLeft !== null && (
            <p className="text-muted">
              Valid for {blocksLeft} more blocks (about {Math.max(1, Math.round((blocksLeft * 25) / 60))} min).
            </p>
          )}
          <label className="flex items-center gap-2 text-muted">
            <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} />
            Send immediately (otherwise at a random moment in the next few minutes, so payments don&apos;t form a
            timing pattern)
          </label>
          {canSign && (
            <button className="btn" onClick={signHere} disabled={busy || !approved || repriceNeeded}>
              {busy ? "Signing…" : "Sign and send with passkey"}
            </button>
          )}
          {canSign === false && (
            <p className="text-muted">
              This passkey can&apos;t sign for this account yet. Add the account&apos;s seed under <b>Treasury → Add signing key</b>,
              sign in with the passkey that created the account, or use the command-line signer below.
            </p>
          )}
          <details open={canSign === false}>
            <summary className="cursor-pointer text-muted">Sign with an external device (CLI)</summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button className="btn-ghost" onClick={download}>
                Download unsigned transaction
              </button>
              <label className="btn-ghost cursor-pointer">
                Upload signed transaction
                <input
                  type="file"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) await act(async () => submit(new Uint8Array(await f.arrayBuffer())));
                  }}
                />
              </label>
            </div>
            <p className="mono mt-2 text-muted">
              zebfin signer sign --key approver.json zebfin-{payment.id.slice(0, 8)}.created --output signed.pczt
            </p>
          </details>
        </div>
      )}

      {payment.status === "scheduled" && payment.broadcast_at && (
        <p className="mt-3 text-muted">
          Will broadcast at {new Date(payment.broadcast_at).toLocaleTimeString()} (random delay, bounded by the
          transaction&apos;s validity).
        </p>
      )}
      {payment.txid && (
        <>
          <p className="mono mt-3 text-muted">
            txid {payment.txid}
            {payment.mined_height && ` · block ${payment.mined_height}`}
          </p>
          <PublicView
            session={session}
            txid={payment.txid}
            privateLines={[
              ...(payment.request?.recipients ?? []).map((r) => ({
                label: r.memo ? `“${r.memo.slice(0, 32)}${r.memo.length > 32 ? "…" : ""}”` : r.address.slice(0, 14) + "…",
                value: `${formatTaz(r.value_zats)} TAZ`,
              })),
              ...(payment.request?.usd_value != null ? [{ label: "Value", value: `$${payment.request.usd_value.toFixed(2)}` }] : []),
            ]}
          />
        </>
      )}
      {payment.error && <p className="mt-2 text-danger">{payment.error}</p>}
      {error && <p className="mt-2 text-danger">{error}</p>}
    </div>
  );
}
