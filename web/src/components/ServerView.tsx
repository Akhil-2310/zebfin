"use client";

import type { Stored } from "@/lib/records";

/** Shows exactly what our server stores for this org: opaque, padded blobs. */
export function ServerView({ records }: { records: Stored[] }) {
  return (
    <section className="card">
      <h2 className="text-lg font-semibold">What our server sees</h2>
      <p className="mt-1 text-sm text-muted">
        Every record as stored in our database: a random ID and ciphertext padded to a fixed size. No names,
        amounts, addresses or record types.
      </p>
      <ul className="mt-4 space-y-2">
        {records.map((r) => (
          <li key={r.id} className="well p-2">
            <p className="mono text-muted">
              {r.id} · {r.ciphertextBytes} bytes
            </p>
            <p className="mono">{r.ciphertextPreview}…</p>
          </li>
        ))}
        {records.length === 0 && <li className="text-sm text-muted">No records yet.</li>}
      </ul>
    </section>
  );
}
