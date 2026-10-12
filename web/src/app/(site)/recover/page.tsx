"use client";

import { PetIntro } from "@/components/PetIntro";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { isValidRecoveryPhrase } from "@/lib/crypto";
import { recover } from "@/lib/flows";
import { useSession } from "@/lib/session";

export default function RecoverPage() {
  const router = useRouter();
  const { setSession } = useSession();
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = isValidRecoveryPhrase(phrase);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSession(await recover(phrase));
      setPhrase("");
      router.push("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-16">
      <PetIntro mood="sick" eyebrow="Recovery kit" title="Recover access">
          Enter your 24-word recovery kit. It unlocks your organization&apos;s key in this browser, then you&apos;ll
          create a new passkey for this device. The words never leave this page.
      </PetIntro>
      <form onSubmit={onSubmit} className="card mt-6 space-y-4">
        <textarea
          className="input h-32 font-mono"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder="word1 word2 word3 …"
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn w-full" disabled={busy || !valid}>
          {busy ? "Recovering…" : "Recover and add passkey"}
        </button>
        {phrase && !valid && <p className="text-xs text-muted">Not a valid 24-word recovery kit yet.</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
      </form>
    </main>
  );
}
