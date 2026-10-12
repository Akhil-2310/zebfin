"use client";

import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Pet } from "@/components/Pet";
import { AppDataProvider } from "@/lib/app-data";
import { useSession } from "@/lib/session";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  if (!session) {
    return (
      <main className="mx-auto w-full max-w-md px-4 py-16 text-center">
        <div className="screen mx-auto mb-6 flex w-40 justify-center py-4">
          <Pet mood="sleepy" size={96} />
        </div>
        <h1 className="text-2xl">Zeb is napping</h1>
        <p className="mt-2 text-sm text-muted">Your organization&apos;s key only lives in memory. Sign in to unlock it.</p>
        <Link href="/login" className="btn mt-6">
          Sign in with passkey
        </Link>
      </main>
    );
  }
  return (
    <AppDataProvider session={session}>
      <AppShell>{children}</AppShell>
    </AppDataProvider>
  );
}
