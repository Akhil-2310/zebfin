"use client";

import Link from "next/link";
import { useSession } from "@/lib/session";

/** Sign in / Get started, or a way back to the dashboard while a workspace is unlocked. */
export function NavActions() {
  const { session } = useSession();
  if (session) {
    return (
      <Link href="/app" className="btn px-4 py-1.5 text-sm">
        Open dashboard
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Link href="/login" className="btn-ghost px-3 py-1.5 text-sm">
        Sign in
      </Link>
      <Link href="/signup" className="btn hidden px-4 py-1.5 text-sm sm:inline-flex">
        Get started
      </Link>
    </div>
  );
}
