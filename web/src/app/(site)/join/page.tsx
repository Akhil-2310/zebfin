"use client";

import { PetIntro } from "@/components/PetIntro";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { joinWithInvite } from "@/lib/flows";
import { useSession } from "@/lib/session";

export default function JoinPage() {
  const router = useRouter();
  const { setSession } = useSession();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The invite secret is in the URL fragment, which browsers never send to servers.
      setSession(await joinWithInvite(window.location.hash, name.trim()));
      history.replaceState(null, "", "/join");
      router.push("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-4 py-16">
      <PetIntro mood="happy" eyebrow="Invite" title="Join your organization">
          You&apos;ve been invited to an organization on Zebfin. Create a passkey on this device to join. Your invite
          link carries the key to the organization&apos;s encrypted data; it never reaches our servers.
      </PetIntro>
      <form onSubmit={onSubmit} className="card mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="name">
            Your name
          </label>
          <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          <p className="mt-1 text-xs text-muted">Visible to everyone in this workspace, encrypted from us.</p>
        </div>
        <button className="btn w-full" disabled={busy || !name.trim()}>
          {busy ? "Waiting for passkey…" : "Create passkey and join"}
        </button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </form>
    </main>
  );
}
