"use client";

import { useEffect, useState } from "react";
import { post } from "@/lib/api";
import { createPortal, portalLink, readResponse } from "@/lib/portal";
import { deleteRecord, saveRecord, type Contributor, type Stored } from "@/lib/records";
import type { Session } from "@/lib/session";
import { validateAddress } from "@/lib/signer";

/** Contributors go into the payee book (best effort: members can't add payees). */
async function registerPayee(session: Session, address: string, label: string) {
  try {
    await post("/v1/payees", { address }, session.token);
    await saveRecord(session, { type: "payee", address, label });
  } catch {}
}

export function Contributors({
  session,
  contributors,
  onChanged,
}: {
  session: Session;
  contributors: Stored<Contributor>[];
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"link" | "manual">("link");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [address, setAddress] = useState("");
  const [monthly, setMonthly] = useState("1.50");
  const [currency, setCurrency] = useState<"USD" | "TAZ">("USD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  // Pick up addresses contributors have submitted through their portals.
  useEffect(() => {
    const pending = contributors.filter((c) => !c.value.address && c.value.portalId && c.value.portalSecret);
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      let changed = false;
      for (const c of pending) {
        const r = await readResponse(session, c.value.portalId!, c.value.portalSecret!).catch(() => null);
        if (cancelled || !r) continue;
        if (await validateAddress(r.address)) continue; // ignore invalid submissions
        await saveRecord(session, { ...c.value, address: r.address }, c.id);
        await registerPayee(session, r.address, c.value.name);
        changed = true;
      }
      if (changed && !cancelled) onChanged();
    })();
    return () => {
      cancelled = true;
    };
  }, [contributors, session, onChanged]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const base: Contributor = {
        type: "contributor",
        name: name.trim(),
        role: role.trim(),
        address: "",
        payCurrency: currency,
        monthlyTaz: currency === "TAZ" ? Number(monthly) : 0,
        monthlyUsd: currency === "USD" ? Number(monthly) : undefined,
      };
      if (mode === "manual") {
        const problem = await validateAddress(address);
        if (problem) throw new Error(problem);
        base.address = address.trim();
      }
      // Every contributor gets a portal for payslips; invited ones also submit their address there.
      const { portalId, secret } = await createPortal(session, {
        orgName: session.orgName,
        contributorName: base.name,
        role: base.role,
      });
      const id = await saveRecord(session, { ...base, portalId, portalSecret: secret });
      if (base.address) await registerPayee(session, base.address, base.name);
      setShown(id);
      setName("");
      setRole("");
      setAddress("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="text-lg font-semibold">Contributors</h2>
      <p className="mt-1 text-sm text-muted">
        Encrypted in your browser. Each person gets a private portal link for their payout address and payslips;
        they never see anyone else&apos;s.
      </p>
      {contributors.length > 0 && (
        <ul className="mt-4 divide-y divide-border text-sm">
          {contributors.map((c) => {
            const link = c.value.portalId && c.value.portalSecret ? portalLink(c.value.portalId, c.value.portalSecret) : null;
            return (
              <li key={c.id} className="py-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {c.value.name} <span className="font-normal text-muted">· {c.value.role}</span>
                    </p>
                    {c.value.address ? (
                      <p className="mono text-muted">{c.value.address.slice(0, 28)}…</p>
                    ) : (
                      <p className="text-xs text-accent-ink">Waiting for them to submit an address</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums">
                      {c.value.payCurrency === "USD" ? `$${c.value.monthlyUsd?.toFixed(2)}/mo` : `${c.value.monthlyTaz} TAZ/mo`}
                    </span>
                    {link && (
                      <button className="text-xs text-muted hover:text-foreground" onClick={() => setShown(shown === c.id ? null : c.id)}>
                        Portal link
                      </button>
                    )}
                    <button
                      className="text-xs text-muted hover:text-danger"
                      onClick={async () => {
                        await deleteRecord(session, c.id);
                        onChanged();
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                {link && shown === c.id && (
                  <div className="mt-2 well p-2">
                    <p className="mono">{link}</p>
                    <div className="mt-1 flex items-center gap-3">
                      <button className="btn-ghost px-3 py-1 text-xs" onClick={() => navigator.clipboard.writeText(link)}>
                        Copy
                      </button>
                      <span className="text-xs text-muted">Send privately. Whoever has it can see this person&apos;s payslips.</span>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={add} className="mt-4 space-y-3">
        <div className="seg">
          {(
            [
              ["link", "Invite by link"],
              ["manual", "Enter address"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={mode === m ? "seg-on" : ""}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input className="input" placeholder="Role" value={role} onChange={(e) => setRole(e.target.value)} required />
          {mode === "manual" && (
            <input
              className="input mono sm:col-span-2"
              placeholder="Shielded address (utest1…)"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              required
            />
          )}
          <div className="flex items-center gap-2">
            <input className="input" value={monthly} onChange={(e) => setMonthly(e.target.value)} inputMode="decimal" />
            <select className="input w-auto" value={currency} onChange={(e) => setCurrency(e.target.value as "USD" | "TAZ")}>
              <option value="USD">USD/mo</option>
              <option value="TAZ">TAZ/mo</option>
            </select>
          </div>
          <button className="btn" disabled={busy}>
            {busy ? "Encrypting…" : mode === "link" ? "Create invite link" : "Add contributor"}
          </button>
        </div>
        {mode === "link" && (
          <p className="text-xs text-muted">
            They open the link, paste a fresh shielded address from their own wallet, and it appears here. No account
            needed.
          </p>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </form>
    </section>
  );
}
