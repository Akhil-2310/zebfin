"use client";

import { useEffect, useState } from "react";
import { api, post, put, type MembersResponse, type Policy, type PolicyView } from "@/lib/api";
import { ADAPTIVE_SOLO_LIMIT_USD, adaptiveApprovals, PRESETS, presetOf, type Preset } from "@/lib/policy-presets";
import type { MemberLabel, Stored } from "@/lib/records";
import type { Session } from "@/lib/session";

export function PolicyPanel({ session, memberLabels }: { session: Session; memberLabels: Stored<MemberLabel>[] }) {
  const [view, setView] = useState<PolicyView | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [approvers, setApprovers] = useState(0);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<PolicyView>("/v1/policy", { token: session.token }),
      api<MembersResponse>("/v1/members", { token: session.token }),
    ]).then(
      ([v, m]) => {
        if (cancelled) return;
        setView(v);
        setIsAdmin(m.members.find((x) => x.is_me)?.role === "admin");
        setApprovers(m.members.filter((x) => x.role !== "member").length);
      },
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [session.token, version]);

  if (!view) return null;
  const p = view.policy;
  const nameOf = (id: string | null) => memberLabels.find((m) => m.value.memberId === id)?.value.name ?? "an admin";

  async function propose(policy: Policy) {
    await put("/v1/policy", policy, session.token);
  }

  async function applyPreset(k: Preset) {
    setError(null);
    try {
      // Keep any caps and holds already set; presets only change who approves.
      await propose({ ...p, adaptive: PRESETS[k].policy.adaptive, tiers: PRESETS[k].policy.tiers });
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    if (!draft) return;
    setError(null);
    try {
      await propose(draft);
      setDraft(null);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function confirm() {
    setError(null);
    try {
      await post("/v1/policy/confirm", {}, session.token);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const d = draft;
  const current = presetOf(p);
  // Small payments need the lowest tier's approvals; flag when even those can't be met.
  // Adaptive approvals never ask for more people than the team has.
  const fewest = p.adaptive ? 1 : Math.min(...p.tiers.map((t) => t.approvals));
  const stuck = approvers < fewest;
  const limit = `$${ADAPTIVE_SOLO_LIMIT_USD.toLocaleString()}`;
  return (
    <section className="card">
      <h2 className="text-lg font-semibold">Spending policy</h2>
      <p className="mt-1 text-xs text-muted">
        Enforced by our server on every payment until threshold signing (FROST) makes it cryptographic.
      </p>
      {!d && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="chip chip-sun">{current ? `${current === "solo" ? "🧑" : "👥"} ${PRESETS[current].label}` : "Custom"}</span>
          {isAdmin &&
            (Object.keys(PRESETS) as Preset[])
              .filter((k) => k !== current)
              .map((k) => (
                <button key={k} className="btn-ghost px-3 py-1 text-xs" onClick={() => applyPreset(k)} title={PRESETS[k].blurb}>
                  Switch to {PRESETS[k].label.toLowerCase()}
                </button>
              ))}
        </div>
      )}
      {!d && stuck && (
        <p className="mt-2 text-xs text-danger">
          Every payment needs at least {fewest} approvers but your org has {approvers}. Invite an approver under Team, or switch to
          &ldquo;just me&rdquo;.
        </p>
      )}
      {!d ? (
        <ul className="mt-3 space-y-1 text-sm">
          {p.adaptive ? (
            <>
              <li>
                <b>Adapts to your team</b> ({approvers} approver{approvers === 1 ? "" : "s"} now):
              </li>
              {approvers <= 1 && <li>· Any payment: 1 approval (just you)</li>}
              {approvers === 2 && (
                <>
                  <li>· Under {limit}: 1 approval (either of you)</li>
                  <li>· {limit} and above: 2 approvals (both of you)</li>
                </>
              )}
              {approvers >= 3 && (
                <li>
                  · Any payment: {adaptiveApprovals(approvers, 0)} approvals (a majority of {approvers})
                </li>
              )}
              <li className="text-xs text-muted">Updates automatically when someone joins or leaves.</li>
            </>
          ) : (
            p.tiers.map((t, i) => (
              <li key={i}>
                {t.above_usd === 0 ? "Any payment" : `Above $${t.above_usd.toLocaleString()}`}: {t.approvals} approval
                {t.approvals === 1 ? "" : "s"}
              </li>
            ))
          )}
          <li>Daily cap per account: {p.daily_cap_usd ? `$${p.daily_cap_usd.toLocaleString()}` : "none"}</li>
          <li>Monthly cap per account: {p.monthly_cap_usd ? `$${p.monthly_cap_usd.toLocaleString()}` : "none"}</li>
          <li>
            New payees: payments over ${p.new_payee_hold_above_usd.toLocaleString()} held for {p.new_payee_hold_hours}h after
            they&apos;re added
          </li>
        </ul>
      ) : (
        <div className="mt-3 space-y-2 text-sm">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={!!d.adaptive} onChange={(e) => setDraft({ ...d, adaptive: e.target.checked })} />
            <span>
              <b>Adapt approvals to team size.</b>{" "}
              <span className="text-muted">
                With two approvers, either approves under {limit} and both above; with three or more, a majority. Turn off to use
                the fixed tiers below.
              </span>
            </span>
          </label>
          {!d.adaptive && d.tiers.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-20 text-muted">Above $</span>
              <input
                className="input w-28"
                value={t.above_usd}
                onChange={(e) => setDraft({ ...d, tiers: d.tiers.map((x, j) => (j === i ? { ...x, above_usd: Number(e.target.value) } : x)) })}
              />
              <input
                className="input w-16"
                value={t.approvals}
                onChange={(e) => setDraft({ ...d, tiers: d.tiers.map((x, j) => (j === i ? { ...x, approvals: Number(e.target.value) } : x)) })}
              />
              <span className="text-muted">approvals</span>
              {d.tiers.length > 1 && (
                <button className="text-xs text-muted hover:text-danger" onClick={() => setDraft({ ...d, tiers: d.tiers.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {!d.adaptive && (
            <button className="text-xs text-accent-ink" onClick={() => setDraft({ ...d, tiers: [...d.tiers, { above_usd: 0, approvals: 2 }] })}>
              + Add tier
            </button>
          )}
          {(
            [
              ["daily_cap_usd", "Daily cap $ (blank = none)"],
              ["monthly_cap_usd", "Monthly cap $ (blank = none)"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <span className="w-48 text-muted">{label}</span>
              <input
                className="input w-28"
                value={d[k] ?? ""}
                onChange={(e) => setDraft({ ...d, [k]: e.target.value ? Number(e.target.value) : null })}
              />
            </label>
          ))}
          <label className="flex items-center gap-2">
            <span className="w-48 text-muted">Hold new payees above $</span>
            <input
              className="input w-28"
              value={d.new_payee_hold_above_usd}
              onChange={(e) => setDraft({ ...d, new_payee_hold_above_usd: Number(e.target.value) })}
            />
            <span className="text-muted">for</span>
            <input
              className="input w-16"
              value={d.new_payee_hold_hours}
              onChange={(e) => setDraft({ ...d, new_payee_hold_hours: Number(e.target.value) })}
            />
            <span className="text-muted">h</span>
          </label>
          <div className="flex gap-2">
            <button className="btn" onClick={save}>
              Propose change
            </button>
            <button className="btn-ghost" onClick={() => setDraft(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
      {view.pending && (
        <div className="mt-3 well p-3 text-sm">
          <p>
            A change proposed by {view.pending_by === session.memberId ? "you" : nameOf(view.pending_by)} is waiting for a
            second admin.
          </p>
          <p className="mt-1 text-xs text-muted">
            {view.pending.adaptive ? "Adaptive approvals" : `Tiers: ${view.pending.tiers.map((t) => `>$${t.above_usd}→${t.approvals}`).join(", ")}`} · daily{" "}
            {view.pending.daily_cap_usd ?? "none"} · monthly {view.pending.monthly_cap_usd ?? "none"} · hold ${view.pending.new_payee_hold_above_usd}/
            {view.pending.new_payee_hold_hours}h
          </p>
          {isAdmin && view.pending_by !== session.memberId && (
            <button className="btn mt-2" onClick={confirm}>
              Confirm change
            </button>
          )}
        </div>
      )}
      {isAdmin && !d && (
        <button className="btn-ghost mt-3 px-3 py-1 text-xs" onClick={() => setDraft(structuredClone(p))}>
          Edit policy
        </button>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
