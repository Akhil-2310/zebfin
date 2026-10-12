"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { formatTaz } from "@/lib/records";
import type { Session } from "@/lib/session";

interface PublicTx {
  txid: string;
  mined_height: number | null;
  size_bytes: number;
  version: string;
  transparent_inputs: number;
  transparent_outputs: number;
  sapling_spends: number;
  sapling_outputs: number;
  orchard_actions: number;
  ironwood_actions: number;
  orchard_value_balance: number;
  ironwood_value_balance: number;
  sample_ciphertext_hex: string | null;
  sample_nullifier_hex: string | null;
}

/**
 * Side by side: what the team knows about a payment vs. what anyone reading
 * the chain can see, decoded from the raw transaction.
 */
export function PublicView({
  session,
  txid,
  privateLines,
}: {
  session: Session;
  txid: string;
  privateLines: { label: string; value: string }[];
}) {
  const [tx, setTx] = useState<PublicTx | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    setOpen((o) => !o);
    if (tx) return;
    try {
      setTx(await api<PublicTx>(`/v1/public/tx/${txid}`, { token: session.token }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const shielded = tx ? tx.orchard_actions + tx.ironwood_actions : 0;
  return (
    <div className="mt-3">
      <button className="btn-ghost px-3 py-1 text-xs" onClick={load}>
        {open ? "Hide" : "What the public sees"}
      </button>
      {open && (
        <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
          <div className="rounded-lg border border-border p-3">
            <p className="label">Inside your workspace</p>
            <ul className="space-y-1">
              {privateLines.map((l, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="text-muted">{l.label}</span>
                  <span className="mono text-right">{l.value}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="well p-3">
            <p className="label">Anyone on the chain sees</p>
            {!tx ? (
              <p className="text-muted">{error ?? "Decoding the raw transaction…"}</p>
            ) : (
              <ul className="space-y-1">
                <li className="flex justify-between">
                  <span className="text-muted">Transaction</span>
                  <span className="mono">{tx.txid.slice(0, 16)}…</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted">Block</span>
                  <span>{tx.mined_height ?? "unconfirmed"}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted">Shielded actions</span>
                  <span>
                    {shielded} ({tx.ironwood_actions ? "Ironwood" : "Orchard"} pool)
                  </span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted">Transparent inputs / outputs</span>
                  <span>
                    {tx.transparent_inputs} / {tx.transparent_outputs}
                  </span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted">Net value leaving the pool</span>
                  <span>{formatTaz(tx.orchard_value_balance + tx.ironwood_value_balance)} TAZ (the fee)</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted">Sender, recipients, amounts</span>
                  <span>encrypted</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted">Memos</span>
                  <span>encrypted</span>
                </li>
                {tx.sample_ciphertext_hex && (
                  <li>
                    <span className="text-muted">A note on chain: </span>
                    <span className="mono break-all">{tx.sample_ciphertext_hex}…</span>
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
