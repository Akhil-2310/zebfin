"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { api, post, type Balance, type HistoryEntry } from "@/lib/api";
import { formatTaz, saveRecord, type AccountLabel, type Stored } from "@/lib/records";
import type { SeedPayload } from "@/lib/crypto";
import type { Session } from "@/lib/session";
import { createSiblingAccount } from "@/lib/accounts";
import { exportAccount, generateSeed, hasSigningKey, storeSigningKey, type AccountExport } from "@/lib/signer";

interface Props {
  session: Session;
  accounts: string[];
  labels: Stored<AccountLabel>[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
}

export function Treasury({ session, accounts, labels, selected, onSelect, onChanged }: Props) {
  const nameOf = (id: string) => labels.find((l) => l.value.accountId === id)?.value.name ?? "Unnamed account";

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Treasury</h2>
        {accounts.length > 1 && (
          <select className="input w-auto" value={selected ?? ""} onChange={(e) => onSelect(e.target.value)}>
            {accounts.map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </select>
        )}
      </div>
      {selected ? (
        <AccountView key={selected} session={session} accountId={selected} name={nameOf(selected)} labels={labels} onChanged={onChanged} />
      ) : (
        <ConnectAccount session={session} onConnected={onChanged} />
      )}
      {selected && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-muted">Connect another account</summary>
          <ConnectAccount session={session} onConnected={onChanged} />
        </details>
      )}
    </section>
  );
}

type ConnectMode = "new" | "import" | "viewonly";

function ConnectAccount({ session, onConnected }: { session: Session; onConnected: () => void }) {
  const [mode, setMode] = useState<ConnectMode>("new");
  const [name, setName] = useState("Operating");
  const [ufvk, setUfvk] = useState("");
  const [fp, setFp] = useState("");
  const [index, setIndex] = useState("0");
  const [birthday, setBirthday] = useState("");
  const [phrase, setPhrase] = useState("");
  const [fresh, setFresh] = useState<(AccountExport & { mnemonic: string }) | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(exp: AccountExport, seed?: SeedPayload) {
    const { account_id } = await post<{ account_id: string }>(
      "/v1/accounts",
      {
        ufvk: exp.ufvk,
        seed_fingerprint: exp.seed_fingerprint,
        account_index: exp.account_index,
        birthday: birthday ? Number(birthday) : null,
      },
      session.token,
    );
    await saveRecord(session, {
      type: "account",
      accountId: account_id,
      name: name.trim(),
      seedFingerprint: exp.seed_fingerprint,
      accountIndex: exp.account_index,
    });
    // Passkey prompt: wraps the seed under this approver's passkey.
    if (seed) await storeSigningKey(session, account_id, seed);
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const tabs: [ConnectMode, string][] = [
    ["new", "New key in this browser"],
    ["import", "Import seed phrase"],
    ["viewonly", "View-only (external signer)"],
  ];

  return (
    <div className="mt-4 space-y-3">
      <div className="seg flex-wrap">
        {tabs.map(([m, label]) => (
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
        <div>
          <label className="label">Account name (encrypted)</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="label">Birthday height (optional)</label>
          <input className="input" value={birthday} onChange={(e) => setBirthday(e.target.value)} placeholder="recent block" />
        </div>
      </div>

      {mode === "new" && !fresh && (
        <>
          <p className="text-sm text-muted">
            Generates the account&apos;s spending key here. Our server gets only the view-only key; the spending key is
            stored wrapped under your passkey and unwrapped only when you sign.
          </p>
          <button className="btn" disabled={busy} onClick={async () => setFresh(await generateSeed(0))}>
            Generate account key
          </button>
        </>
      )}
      {mode === "new" && fresh && (
        <>
          <p className="text-sm">
            Back up this <strong>account seed</strong>. It controls the funds; it&apos;s different from your recovery kit,
            and we can&apos;t restore it.
          </p>
          <ol className="grid grid-cols-2 gap-x-6 gap-y-1 well p-3 sm:grid-cols-4">
            {fresh.mnemonic.split(" ").map((w, i) => (
              <li key={i} className="font-mono text-sm">
                <span className="mr-2 inline-block w-5 text-right text-muted">{i + 1}.</span>
                {w}
              </li>
            ))}
          </ol>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={backedUp} onChange={(e) => setBackedUp(e.target.checked)} />
            I&apos;ve backed up the account seed
          </label>
          <button
            className="btn"
            disabled={busy || !backedUp}
            onClick={() => run(() => connect(fresh, { mnemonic: fresh.mnemonic, accountIndex: fresh.account_index }))}
          >
            {busy ? "Waiting for passkey…" : "Connect and protect with passkey"}
          </button>
        </>
      )}

      {mode === "import" && (
        <>
          <p className="text-sm text-muted">Paste an existing testnet seed phrase (e.g. from the zebfin CLI key file).</p>
          <textarea
            className="input mono h-24"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="24 words"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className="btn"
            disabled={busy || phrase.trim().split(/\s+/).length < 12}
            onClick={() =>
              run(async () => {
                const exp = await exportAccount(phrase, Number(index));
                await connect(exp, { mnemonic: phrase.trim().toLowerCase().split(/\s+/).join(" "), accountIndex: Number(index) });
                setPhrase("");
              })
            }
          >
            {busy ? "Waiting for passkey…" : "Import and protect with passkey"}
          </button>
        </>
      )}

      {mode === "viewonly" && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => connect({ ufvk: ufvk.trim(), seed_fingerprint: fp.trim(), account_index: Number(index) }));
          }}
        >
          <p className="text-sm text-muted">
            For keys held elsewhere: run <code className="mono">zebfin signer export --key …</code> and paste the result.
            Payments are then signed with the CLI.
          </p>
          <textarea className="input mono h-20" value={ufvk} onChange={(e) => setUfvk(e.target.value)} placeholder="uviewtest1…" required />
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <input className="input mono" value={fp} onChange={(e) => setFp(e.target.value)} placeholder="Seed fingerprint" required />
            <input className="input" value={index} onChange={(e) => setIndex(e.target.value)} required />
          </div>
          <button className="btn" disabled={busy}>
            {busy ? "Importing and scanning…" : "Connect view-only account"}
          </button>
        </form>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

/**
 * A new ZIP 32 account from the same seed as `from` (next index), e.g. a
 * separate payroll account. Separate accounts keep each viewing key's scope
 * narrow, which is what makes per-account auditor access meaningful.
 */
function SiblingAccount({
  session,
  from,
  labels,
  onChanged,
}: {
  session: Session;
  from: string;
  labels: Stored<AccountLabel>[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("Payroll");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await createSiblingAccount(session, from, name.trim(), labels);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <input className="input w-40" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn-ghost" onClick={create} disabled={busy || !name.trim()}>
        {busy ? "Waiting for passkey…" : "Create account from this key"}
      </button>
      <span className="text-xs text-muted">Same seed, next ZIP 32 account: its own addresses, balance and viewing key.</span>
      {error && <p className="w-full text-danger">{error}</p>}
    </div>
  );
}

function AccountView({
  session,
  accountId,
  name,
  labels,
  onChanged,
}: {
  session: Session;
  accountId: string;
  name: string;
  labels: Stored<AccountLabel>[];
  onChanged: () => void;
}) {
  const [hasKey, setHasKey] = useState(false);
  useEffect(() => {
    let cancelled = false;
    hasSigningKey(session, accountId).then((h) => !cancelled && setHasKey(h), () => {});
    return () => {
      cancelled = true;
    };
  }, [session, accountId]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      Promise.all([
        api<Balance>(`/v1/accounts/${accountId}/balance`, { token: session.token }),
        api<HistoryEntry[]>(`/v1/accounts/${accountId}/history`, { token: session.token }),
      ]).then(
        ([b, h]) => {
          setBalance(b);
          setHistory(h);
          // A brand-new account fails until its first scan; clear that once it's synced.
          setError(null);
        },
        (err) => setError(err instanceof Error ? err.message : String(err)),
      ),
    [accountId, session.token],
  );

  useEffect(() => {
    const t = setInterval(refresh, 20_000);
    const first = setTimeout(refresh, 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [refresh]);

  async function sync() {
    setSyncing(true);
    try {
      setBalance(await post<Balance>(`/v1/accounts/${accountId}/sync`, {}, session.token));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  const [copied, setCopied] = useState(false);
  const [faucet, setFaucet] = useState<{ enabled: boolean; amount_zats: number; wait_secs: number } | null>(null);
  const [dripping, setDripping] = useState(false);
  const [dripMsg, setDripMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ enabled: boolean; amount_zats: number; wait_secs: number }>("/v1/faucet", { token: session.token }).then(
      (f) => !cancelled && setFaucet(f),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [session.token]);

  // Testnet only: Zebfin's own faucet sends a little TAZ to a fresh address of this account.
  async function getTestTaz() {
    setDripping(true);
    setDripMsg(null);
    setError(null);
    try {
      const r = await post<{ txid: string; amount_zats: number }>("/v1/faucet", { account_id: accountId }, session.token);
      setDripMsg(`🚰 Sent ${formatTaz(r.amount_zats)} TAZ. It shows here in a minute or two (tx ${r.txid.slice(0, 10)}…).`);
      setFaucet((f) => (f ? { ...f, wait_secs: 3600 } : f));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDripping(false);
    }
  }

  async function newAddress() {
    try {
      const { address } = await post<{ address: string }>(`/v1/accounts/${accountId}/addresses`, {}, session.token);
      setAddress(address);
      setCopied(false);
      setQr(await QRCode.toDataURL(`zcash:${address}`, { margin: 1, width: 220 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const spendable = balance ? balance.orchard_spendable_zats + balance.ironwood_spendable_zats : 0;

  return (
    <div className="mt-4 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">{name}</p>
          <p className="text-3xl font-semibold tabular-nums">
            {balance ? formatTaz(balance.total_zats) : "…"} <span className="text-base text-muted">TAZ</span>
          </p>
          {balance && (
            <p className="text-xs text-muted">
              {formatTaz(spendable)} spendable
              {balance.pending_zats > 0 && ` · ${formatTaz(balance.pending_zats)} confirming`} · synced to block{" "}
              {balance.fully_scanned ?? balance.chain_tip}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={sync} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync"}
          </button>
          {faucet?.enabled && (
            <button
              className="btn-ghost"
              onClick={getTestTaz}
              disabled={dripping || faucet.wait_secs > 0}
              title={faucet.wait_secs > 0 ? "One faucet request per org per hour" : `Sends ${formatTaz(faucet.amount_zats)} testnet TAZ`}
            >
              {dripping ? "Sending…" : faucet.wait_secs > 0 ? "🚰 Faucet used" : "🚰 Get test TAZ"}
            </button>
          )}
          <button className="btn" onClick={newAddress}>
            New receiving address
          </button>
        </div>
      </div>

      {dripMsg && <p className="text-sm text-ok">{dripMsg}</p>}
      {address && (
        <div className="well flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {qr && <img src={qr} alt="Receiving address QR code" className="h-40 w-40 rounded bg-white p-1" />}
          <div className="min-w-0">
            <p className="label">Fresh shielded address (Orchard receiver only)</p>
            <p className="mono">{address}</p>
            <button
              className="btn-ghost mt-2 px-3 py-1 text-xs"
              onClick={() => navigator.clipboard.writeText(address).then(() => setCopied(true), () => {})}
            >
              {copied ? "Copied ✓" : "Copy address"}
            </button>
            <p className="mt-2 text-xs text-muted">
              A new address every time, so payers can&apos;t link your receipts together. Every address you create
              keeps working: funds sent to any of them arrive in this account.
            </p>
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold">Activity</h3>
        {history.length === 0 ? (
          <p className="text-sm text-muted">No transactions yet. Send testnet TAZ to a fresh address.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {history
              .filter((h) => !h.is_change)
              .map((h) => (
                <li key={`${h.txid}-${h.direction}-${h.value_zats}-${h.memo}`} className="flex flex-wrap justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <span className={h.direction === "received" ? "text-ok" : ""}>
                      {h.direction === "received" ? "Received" : h.direction === "sent" ? "Sent" : "Internal"}
                    </span>
                    {h.memo && <span className="ml-2 text-muted">“{h.memo}”</span>}
                    <p className="mono text-muted">
                      {h.txid.slice(0, 16)}… · {h.mined_height ? `block ${h.mined_height}` : "unconfirmed"} · {h.pool}
                    </p>
                  </div>
                  <span className="tabular-nums">
                    {h.direction === "received" ? "+" : "−"}
                    {formatTaz(h.value_zats)}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>
      {hasKey && (
        <details>
          <summary className="cursor-pointer text-sm text-muted">Separate account for a purpose (payroll, reserves…)</summary>
          <SiblingAccount session={session} from={accountId} labels={labels} onChanged={onChanged} />
        </details>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
