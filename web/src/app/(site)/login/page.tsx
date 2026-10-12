"use client";

import Link from "next/link";
import { PetIntro } from "@/components/PetIntro";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { login } from "@/lib/flows";
import { useSession } from "@/lib/session";

export default function LoginPage() {
  const router = useRouter();
  const { setSession } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLogin() {
    setBusy(true);
    setError(null);
    try {
      setSession(await login());
      router.push("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-4 py-16">
      <PetIntro mood="happy" eyebrow="Welcome back" title="Sign in">
          One passkey prompt signs you in and unlocks your organization&apos;s key on this device.
      </PetIntro>
      <div className="card mt-6 space-y-4">
        <button className="btn w-full" onClick={onLogin} disabled={busy}>
          {busy ? "Waiting for passkey…" : "Sign in with passkey"}
        </button>
        {error && <p className="text-sm text-danger">{error}</p>}
        <p className="text-xs text-muted">
          Lost your passkey?{" "}
          <Link href="/recover" className="underline">
            Use your recovery kit
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
