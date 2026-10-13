"use client";

import { useEffect, useState } from "react";
import { api, type MembersResponse, type Role } from "@/lib/api";
import { createInvite } from "@/lib/flows";
import type { MemberLabel, Stored } from "@/lib/records";
import type { Session } from "@/lib/session";

const ROLE_HELP: Record<Role, string> = {
  admin: "Manages members and policy, approves payments",
  approver: "Approves payments",
  member: "Can view; can't approve",
};

export function Members({ session, labels }: { session: Session; labels: Stored<MemberLabel>[] }) {
  const [data, setData] = useState<MembersResponse | null>(null);
  const [role, setRole] = useState<Role>("approver");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<MembersResponse>("/v1/members", { token: session.token }).then(
      (d) => !cancelled && setData(d),
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [session.token, version]);

  const nameOf = (id: string) => labels.find((l) => l.value.memberId === id)?.value.name ?? "Pending name";
  const me = data?.members.find((m) => m.is_me);
  const isAdmin = me?.role === "admin";
  const approvers = data?.members.filter((m) => m.role !== "member").length ?? 0;

  async function invite() {
    setBusy(true);
    setError(null);
    try {
      setLink(await createInvite(session, role));
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="text-lg font-semibold">Team</h2>
      {data && (
        <ul className="mt-3 divide-y divide-border text-sm">
          {data.members.map((m) => (
            <li key={m.member_id} className="flex items-center justify-between py-2">
              <span>
                {nameOf(m.member_id)}
                {m.is_me && <span className="text-muted"> (you)</span>}
              </span>
              <span className="text-muted" title={ROLE_HELP[m.role]}>
                {m.role}
              </span>
            </li>
          ))}
        </ul>
      )}

      {data && (
        <div className="mt-4 well p-3 text-sm">
          <p>
            Payments need at least <strong>{data.approval_threshold}</strong> approval
            {data.approval_threshold > 1 && "s"} from different people (more for larger amounts; see Spending policy).
          </p>
          {approvers < data.approval_threshold && (
            <p className="mt-1 text-danger">
              Only {approvers} member{approvers !== 1 && "s"} can approve. Invite an approver so payroll can go out.
            </p>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="mt-4 space-y-2">
          <div className="flex gap-2">
            <select className="input w-auto" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="approver">Approver</option>
              <option value="admin">Admin</option>
              <option value="member">Member</option>
            </select>
            <button className="btn" onClick={invite} disabled={busy}>
              {busy ? "Creating…" : "Create invite link"}
            </button>
          </div>
          {link && (
            <div className="rounded-lg border border-border p-3">
              <p className="label">Single-use invite, valid 7 days</p>
              <p className="mono">{link}</p>
              <button className="btn-ghost mt-2 px-3 py-1 text-xs" onClick={() => navigator.clipboard.writeText(link)}>
                Copy link
              </button>
              <p className="mt-2 text-xs text-muted">
                Anyone with this link can join as {role}. Send it privately. The part after # is the key; it never
                reaches our servers.
              </p>
            </div>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
