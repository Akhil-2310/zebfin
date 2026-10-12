"use client";

// Session state, held only in memory: a page reload drops the org key and the
// session token, and the user unlocks again with one passkey prompt.

import { createContext, useContext, useState } from "react";

export interface Session {
  token: string;
  orgId: string;
  memberId: string;
  orgKey: Uint8Array;
  orgName: string;
  /** The passkey used to unlock this session; approver keys are wrapped per passkey. */
  passkeyRawId: Uint8Array;
  /** Derived from that passkey's PRF output: for data only this member may read. */
  personalKey: Uint8Array;
}

interface Ctx {
  session: Session | null;
  setSession: (s: Session | null) => void;
}

const SessionContext = createContext<Ctx>({ session: null, setSession: () => {} });

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  return <SessionContext.Provider value={{ session, setSession }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
