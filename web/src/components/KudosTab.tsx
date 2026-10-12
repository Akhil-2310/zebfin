"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PaymentCard } from "@/components/PaymentCard";
import { api, post, type MembersResponse, type Payment, type RateQuote } from "@/lib/api";
import { fromB64, newBoxKeypair, newId, openPersonal, openSealed, sealPersonal, sealTo, toB64 } from "@/lib/crypto";
import { DEFAULT_TAGS, badges, kudosMemo, leaderboards, reciprocalFlags, settlementTotals, type Leader } from "@/lib/kudos";
import {
  ZATS_PER_TAZ,
  deleteRecord,
  ofType,
  saveRecord,
  type Kudos,
  type KudosSettings,
  type Stored,
} from "@/lib/records";
import type { Session } from "@/lib/session";
import { validateAddress } from "@/lib/signer";

const EMOJI = ["👏", "🎉", "💛"];
const thisMonth = () => new Date().toISOString().slice(0, 7);

export function KudosTab({
  session,
  records,
  accounts,
  onChanged,
}: {
  session: Session;
  records: Stored[];
  accounts: string[];
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<MembersResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<MembersResponse>("/v1/members", { token: session.token }).then((m) => !cancelled && setMembers(m), () => {});
    return () => {
      cancelled = true;
    };
  }, [session.token]);

  const labels = ofType(records, "member");
  const settings = ofType(records, "kudos-settings")[0];
  const kudos = ofType(records, "kudos");
  const reactions = ofType(records, "kudos-reaction");
  const nameOf = useCallback(
    (id: string) => labels.find((l) => l.value.memberId === id)?.value.name ?? "Teammate",
    [labels],
  );
  const me = members?.members.find((m) => m.is_me);
  const isAdmin = me?.role === "admin";

  if (!settings) {
    return isAdmin ? (
      <Setup session={session} accounts={accounts} records={records} onChanged={onChanged} />
    ) : (
      <p className="card text-sm text-muted">Kudos isn&apos;t set up yet. An admin can start it from this tab.</p>
    );
  }

  const month = thisMonth();
  const hidden = new Set(labels.filter((l) => l.value.hideFromLeaderboards).map((l) => l.value.memberId));
  const lb = leaderboards(kudos.map((k) => k.value), month, hidden);
  const flags = isAdmin ? reciprocalFlags(kudos.map((k) => k.value), month) : [];

  return (
    <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
      <div className="space-y-5">
        <Give session={session} settings={settings.value} kudos={kudos} members={members} nameOf={nameOf} onChanged={onChanged} />
        <section className="card">
          <h2 className="text-lg font-semibold">Team feed</h2>
          <p className="mt-1 text-xs text-muted">Who thanked whom and why. Amounts are sealed: only the giver and the settler can read them.</p>
          <ul className="mt-3 divide-y divide-border text-sm">
            {[...kudos]
              .sort((a, b) => b.value.at.localeCompare(a.value.at))
              .slice(0, 40)
              .map((k) => {
                const rs = reactions.filter((r) => r.value.kudosId === k.id);
                return (
                  <li key={k.id} className="py-2">
                    <p>
                      <strong>{nameOf(k.value.from)}</strong> thanked <strong>{nameOf(k.value.to)}</strong>
                      <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs text-muted">{k.value.tag}</span>
                    </p>
                    <p className="text-muted">“{k.value.note}”</p>
                    <div className="mt-1 flex items-center gap-2 text-xs">
                      {EMOJI.map((e) => {
                        const mine = rs.find((r) => r.value.emoji === e && r.value.by === session.memberId);
                        const n = rs.filter((r) => r.value.emoji === e).length;
                        return (
                          <button
                            key={e}
                            className={`rounded-full border px-2 py-0.5 ${mine ? "border-accent" : "border-border"}`}
                            onClick={async () => {
                              if (mine) await deleteRecord(session, mine.id);
                              else await saveRecord(session, { type: "kudos-reaction", kudosId: k.id, by: session.memberId, emoji: e });
                              onChanged();
                            }}
                          >
                            {e} {n || ""}
                          </button>
                        );
                      })}
                      <span className="text-muted">{new Date(k.value.at).toLocaleDateString()}</span>
                    </div>
                  </li>
                );
              })}
            {kudos.length === 0 && <li className="py-2 text-muted">No kudos yet. Be the first.</li>}
          </ul>
        </section>
      </div>

      <div className="space-y-5">
        <section className="card">
          <h2 className="text-lg font-semibold">Leaderboards · {month}</h2>
          <p className="mt-1 text-xs text-muted">Counts only, never amounts.</p>
          <Board title="Most appreciated" rows={lb.mostAppreciated} nameOf={nameOf} unit="thanks" />
          <Board title="Most generous" rows={lb.mostGenerous} nameOf={nameOf} unit="given" />
          <Board title="Thanked the most people" rows={lb.mostDiverse} nameOf={nameOf} unit="people" />
          {lb.byTag.length > 0 && (
            <div className="mt-3 text-sm">
              <p className="label">By value</p>
              {lb.byTag.map((t) => (
                <p key={t.tag}>
                  {t.tag}: {t.leaders[0] ? `${nameOf(t.leaders[0].memberId)} (${t.leaders[0].count})` : "—"}
                </p>
              ))}
            </div>
          )}
        </section>
        <section className="card">
          <h2 className="text-lg font-semibold">Your badges</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {badges(kudos.map((k) => k.value), session.memberId).map((b) => (
              <li key={b.id} className={b.earned ? "" : "text-muted"}>
                {b.earned ? "🏅" : "○"} {b.label}
              </li>
            ))}
          </ul>
        </section>
        <Profile session={session} labels={labels} onChanged={onChanged} />
        {isAdmin && flags.length > 0 && (
          <section className="card text-sm">
            <h2 className="font-semibold">Review</h2>
            {flags.map(([a, b]) => (
              <p key={a + b} className="text-accent-ink">
                {nameOf(a)} and {nameOf(b)} have thanked each other 3+ times each this month.
              </p>
            ))}
          </section>
        )}
        {settings.value.settlerMemberId === session.memberId && (
          <Settle session={session} settings={settings.value} records={records} nameOf={nameOf} onChanged={onChanged} />
        )}
      </div>
    </div>
  );
}

function Board({ title, rows, nameOf, unit }: { title: string; rows: Leader[]; nameOf: (id: string) => string; unit: string }) {
  return (
    <div className="mt-3 text-sm">
      <p className="label">{title}</p>
      {rows.length === 0 ? (
        <p className="text-muted">—</p>
      ) : (
        <ol className="space-y-0.5">
          {rows.map((r, i) => (
            <li key={r.memberId} className="flex justify-between">
              <span>
                {i + 1}. {nameOf(r.memberId)}
              </span>
              <span className="tabular-nums text-muted">
                {r.count} {unit}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Setup({
  session,
  accounts,
  records,
  onChanged,
}: {
  session: Session;
  accounts: string[];
  records: Stored[];
  onChanged: () => void;
}) {
  const accountLabels = ofType(records, "account");
  const [allowance, setAllowance] = useState("20");
  const [cap, setCap] = useState("50");
  const [accountId, setAccountId] = useState(accounts[0] ?? "");
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    try {
      if (!session.personalKey.length) throw new Error("Sign in with a passkey to start kudos.");
      // The settlement secret is sealed under this admin's passkey-derived key:
      // nobody else (not other members, not our server) can read amounts.
      const kp = newBoxKeypair();
      await saveRecord(session, {
        type: "kudos-settings",
        monthlyAllowanceUsd: Number(allowance),
        perRecipientCapUsd: Number(cap),
        tags: DEFAULT_TAGS,
        accountId,
        settlerMemberId: session.memberId,
        settlementPublicKey: toB64(kp.publicKey),
        settlementSecretSealed: sealPersonal(session.personalKey, { sk: toB64(kp.secretKey) }, "kudos-settlement-key"),
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="card max-w-xl">
      <h2 className="text-lg font-semibold">Start kudos</h2>
      <p className="mt-1 text-sm text-muted">
        Teammates thank each other with small amounts from a monthly allowance. The team sees who thanked whom, never how
        much. At month end you settle everyone in one padded shielded transaction. Unused allowance never leaves the
        treasury.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 text-sm">
        <label>
          <span className="label">Monthly allowance per member ($)</span>
          <input className="input" value={allowance} onChange={(e) => setAllowance(e.target.value)} />
        </label>
        <label>
          <span className="label">Cap per recipient per month ($)</span>
          <input className="input" value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label className="sm:col-span-2">
          <span className="label">Pay from account</span>
          <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a} value={a}>
                {accountLabels.find((l) => l.value.accountId === a)?.value.name ?? a.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-3 text-xs text-muted">You become the settler: only your passkey can open the amounts to pay them out.</p>
      <button className="btn mt-3" onClick={start} disabled={!accountId}>
        Start kudos
      </button>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}

function Give({
  session,
  settings,
  kudos,
  members,
  nameOf,
  onChanged,
}: {
  session: Session;
  settings: KudosSettings;
  kudos: Stored<Kudos>[];
  members: MembersResponse | null;
  nameOf: (id: string) => string;
  onChanged: () => void;
}) {
  const [to, setTo] = useState("");
  const [usd, setUsd] = useState("5");
  const [note, setNote] = useState("");
  const [tag, setTag] = useState(settings.tags[0] ?? "Helping");
  const [error, setError] = useState<string | null>(null);
  const month = thisMonth();

  // What I've given this month, from my own sealed copies.
  const spent = useMemo(() => {
    let sum = 0;
    let unreadable = 0;
    for (const k of kudos) {
      if (k.value.from !== session.memberId || k.value.month !== month) continue;
      try {
        sum += openPersonal<{ usd: number }>(session.personalKey, k.value.amountForGiver, `kudos|${k.id}`).usd;
      } catch {
        unreadable++;
      }
    }
    return { sum, unreadable };
  }, [kudos, session.memberId, session.personalKey, month]);
  const remaining = Math.max(0, settings.monthlyAllowanceUsd - spent.sum);

  async function give(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const amount = Number(usd);
      if (!to || to === session.memberId) throw new Error("Pick a teammate (not yourself).");
      if (!(amount > 0) || amount > remaining) throw new Error(`You have $${remaining.toFixed(2)} left this month.`);
      if (!note.trim()) throw new Error("Say thanks for something specific.");
      const id = newId();
      await saveRecord(
        session,
        {
          type: "kudos",
          from: session.memberId,
          to,
          note: note.trim().slice(0, 140),
          tag,
          month,
          at: new Date().toISOString(),
          amountForSettler: sealTo(fromB64(settings.settlementPublicKey), { usd: amount }, `kudos|${id}`),
          amountForGiver: sealPersonal(session.personalKey, { usd: amount }, `kudos|${id}`),
        },
        id,
      );
      setNote("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const teammates = members?.members.filter((m) => !m.is_me) ?? [];
  return (
    <section className="card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Give kudos</h2>
        <span className="text-sm tabular-nums text-muted">
          ${remaining.toFixed(2)} of ${settings.monthlyAllowanceUsd} left this month
        </span>
      </div>
      {spent.unreadable > 0 && (
        <p className="mt-1 text-xs text-muted">{spent.unreadable} kudos given from another device aren&apos;t counted here.</p>
      )}
      {teammates.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Invite teammates to start thanking each other.</p>
      ) : (
        <form onSubmit={give} className="mt-3 grid gap-2 sm:grid-cols-2">
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)} required>
            <option value="">Thank…</option>
            {teammates.map((m) => (
              <option key={m.member_id} value={m.member_id}>
                {nameOf(m.member_id)}
              </option>
            ))}
          </select>
          <select className="input" value={tag} onChange={(e) => setTag(e.target.value)}>
            {settings.tags.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <input className="input sm:col-span-2" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For…" maxLength={140} />
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">$</span>
            <input className="input" value={usd} onChange={(e) => setUsd(e.target.value)} inputMode="decimal" />
          </div>
          <button className="btn">Send kudos</button>
          {error && <p className="text-sm text-danger sm:col-span-2">{error}</p>}
        </form>
      )}
    </section>
  );
}

function Profile({
  session,
  labels,
  onChanged,
}: {
  session: Session;
  labels: Stored<import("@/lib/records").MemberLabel>[];
  onChanged: () => void;
}) {
  const mine = labels.find((l) => l.value.memberId === session.memberId);
  const [address, setAddress] = useState(mine?.value.payoutAddress ?? "");
  const [msg, setMsg] = useState<string | null>(null);

  async function save(hide?: boolean) {
    setMsg(null);
    const next = { ...(mine?.value ?? { type: "member" as const, memberId: session.memberId, name: "Me" }) };
    if (hide !== undefined) next.hideFromLeaderboards = hide;
    else {
      const problem = await validateAddress(address);
      if (problem) return setMsg(problem);
      next.payoutAddress = address.trim();
    }
    await saveRecord(session, next, mine?.id);
    setMsg("Saved.");
    onChanged();
  }

  return (
    <section className="card text-sm">
      <h2 className="font-semibold">Your kudos settings</h2>
      <label className="mt-2 block">
        <span className="label">Payout address (a fresh shielded address)</span>
        <input className="input mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="utest1…" />
      </label>
      <button className="btn-ghost mt-2 px-3 py-1 text-xs" onClick={() => save()}>
        Save address
      </button>
      <label className="mt-3 flex items-center gap-2">
        <input type="checkbox" checked={!!mine?.value.hideFromLeaderboards} onChange={(e) => save(e.target.checked)} />
        Hide me from leaderboards (I still receive kudos)
      </label>
      {msg && <p className="mt-1 text-xs">{msg}</p>}
    </section>
  );
}

function Settle({
  session,
  settings,
  records,
  nameOf,
  onChanged,
}: {
  session: Session;
  settings: KudosSettings;
  records: Stored[];
  nameOf: (id: string) => string;
  onChanged: () => void;
}) {
  const kudos = ofType(records, "kudos");
  const labels = ofType(records, "member");
  const settled = ofType(records, "kudos-settlement");
  const months = [...new Set(kudos.map((k) => k.value.month))].sort().reverse();
  const [month, setMonth] = useState(months.find((m) => m !== thisMonth()) ?? months[0] ?? thisMonth());
  const [preview, setPreview] = useState<ReturnType<typeof settlementTotals> | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [error, setError] = useState<string | null>(null);

  function decrypt() {
    setError(null);
    try {
      const { sk } = openPersonal<{ sk: string }>(session.personalKey, settings.settlementSecretSealed, "kudos-settlement-key");
      const secret = fromB64(sk);
      const opened = kudos.map((k) => ({
        ...k.value,
        usd: openSealed<{ usd: number }>(secret, k.value.amountForSettler, `kudos|${k.id}`).usd,
      }));
      setPreview(settlementTotals(opened, month, settings.perRecipientCapUsd));
    } catch {
      setError("Couldn't open the amounts: settle from the passkey that started kudos.");
    }
  }

  async function settle() {
    if (!preview) return;
    setError(null);
    try {
      const quote = await api<RateQuote>("/v1/rates/zec-usd", { token: session.token });
      const payable = preview.filter((l) => labels.find((m) => m.value.memberId === l.memberId)?.value.payoutAddress);
      if (!payable.length) throw new Error("No recipients have a payout address yet.");
      const recipients = payable.map((l) => ({
        address: labels.find((m) => m.value.memberId === l.memberId)!.value.payoutAddress!,
        value_zats: Math.round((l.usd / quote.usd_per_zec) * ZATS_PER_TAZ),
        memo: kudosMemo(month, l, nameOf),
      }));
      const p = await post<Payment>(`/v1/accounts/${settings.accountId}/payments`, { kind: "kudos", recipients }, session.token);
      await saveRecord(session, { type: "run", kind: "kudos", paymentId: p.id, period: month, ref: `KUDOS-${month}`, usdPerZec: quote.usd_per_zec, lockedAt: new Date().toISOString() });
      await saveRecord(session, { type: "kudos-settlement", month, paymentId: p.id, at: new Date().toISOString(), recipients: recipients.length });
      setPayment(p);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const done = settled.find((s) => s.value.month === month);
  return (
    <section className="card text-sm">
      <h2 className="font-semibold">Month-end settlement</h2>
      <p className="mt-1 text-xs text-muted">
        Only you can open the amounts. One shielded transaction pays everyone, padded like payroll; each memo lists
        that person&apos;s thank-yous.
      </p>
      <div className="mt-2 flex gap-2">
        <select className="input w-auto" value={month} onChange={(e) => (setMonth(e.target.value), setPreview(null))}>
          {months.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button className="btn-ghost" onClick={decrypt}>
          Preview totals
        </button>
      </div>
      {done && <p className="mt-2 text-ok">Settlement requested {new Date(done.value.at).toLocaleDateString()} for {done.value.recipients} people.</p>}
      {preview && (
        <ul className="mt-2 space-y-1">
          {preview.map((l) => {
            const addr = labels.find((m) => m.value.memberId === l.memberId)?.value.payoutAddress;
            return (
              <li key={l.memberId} className="flex justify-between">
                <span>
                  {nameOf(l.memberId)} · {l.notes.length} thanks
                  {!addr && <span className="text-danger"> · no payout address</span>}
                </span>
                <span className="tabular-nums">
                  ${l.usd.toFixed(2)}
                  {l.capped && <span className="text-xs text-muted"> (capped)</span>}
                </span>
              </li>
            );
          })}
          {preview.length === 0 && <li className="text-muted">Nothing to settle for {month}.</li>}
        </ul>
      )}
      {preview && preview.length > 0 && !done && (
        <button className="btn mt-3" onClick={settle}>
          Request settlement
        </button>
      )}
      {payment && (
        <div className="mt-3">
          <PaymentCard session={session} payment={payment} onUpdate={setPayment} memberLabels={labels} title={`Kudos ${month}`} />
        </div>
      )}
      {error && <p className="mt-2 text-danger">{error}</p>}
      <p className="mt-2 text-xs text-muted">USD totals convert to TAZ at the current ZEC/USD when you request settlement.</p>
    </section>
  );
}
