"use client";

// Org data shared by every dashboard page: decrypted records, accounts, the
// selected treasury account, and Zeb's vitals. Loaded once in the dashboard
// layout so moving between pages doesn't refetch or re-decrypt.

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError, type Balance, type Payment, type RateQuote } from "./api";
import { petMood, type Mood } from "./pet";
import { loadRecords, ofType, type Stored } from "./records";
import { paidPeriods, payDay } from "./schedule";
import { useSession, type Session } from "./session";
import { workspaceMode, type WorkspaceMode } from "./workspace";

const IN_FLIGHT = new Set(["pending_approval", "approved", "proving", "awaiting_signature", "scheduled", "sending"]);

export interface Vitals {
  totalZats: number | null;
  usd: number | null;
  pending: number;
  unwell: boolean;
  celebrate: boolean;
  hour: number;
  deadPaymentIds: Set<string>;
  now: Date;
}

interface AppData {
  session: Session;
  records: Stored[];
  accounts: string[];
  /** Records and accounts have loaded at least once. */
  loaded: boolean;
  selected: string | null;
  setSelected: (id: string) => void;
  reload: () => void;
  vitals: Vitals | null;
  mood: Mood;
  /** Whether a scheduled payroll is due now. */
  payday: boolean;
  mode: WorkspaceMode;
  error: string | null;
}

const Ctx = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppData outside the dashboard layout");
  return v;
}

export function AppDataProvider({ session, children }: { session: Session; children: React.ReactNode }) {
  const router = useRouter();
  const { setSession } = useSession();
  const [records, setRecords] = useState<Stored[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadRecords(session), api<{ account_id: string }[]>("/v1/accounts", { token: session.token })]).then(
      ([recs, accs]) => {
        if (cancelled) return;
        const ids = accs.map((a) => a.account_id);
        setRecords(recs);
        setAccounts(ids);
        setSelected((cur) => (cur && ids.includes(cur) ? cur : (ids[0] ?? null)));
        setLoaded(true);
        setError(null);
      },
      (err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setSession(null);
          router.push("/login");
        } else setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session, version, setSession, router]);

  // Zeb's vitals: balances, payments in flight, and the rate for a USD figure.
  useEffect(() => {
    let cancelled = false;
    const t = session.token;
    const load = () =>
      Promise.all([
        Promise.all(accounts.map((a) => api<Balance>(`/v1/accounts/${a}/balance`, { token: t }).catch(() => null))),
        Promise.all(accounts.map((a) => api<Payment[]>(`/v1/accounts/${a}/payments`, { token: t }).catch(() => [] as Payment[]))),
        api<RateQuote>("/v1/rates/zec-usd", { token: t }).catch(() => null),
      ]).then(([balances, payments, rate]) => {
        if (cancelled) return;
        const now = Date.now();
        const all = payments.flat();
        const known = balances.filter((b): b is Balance => b != null);
        const totalZats = known.length ? known.reduce((s, b) => s + b.total_zats, 0) : null;
        const recent = (p: Payment, ms: number) => now - Date.parse(p.broadcast_at ?? p.created_at) < ms;
        setVitals({
          totalZats,
          usd: totalZats != null && rate ? (totalZats / 1e8) * rate.usd_per_zec : null,
          pending: all.filter((p) => IN_FLIGHT.has(p.status)).length,
          unwell: all.some((p) => p.status === "failed" && recent(p, 24 * 3600e3)),
          celebrate: all.some((p) => p.status === "mined" && recent(p, 15 * 60e3)),
          hour: new Date().getHours(),
          deadPaymentIds: new Set(all.filter((p) => p.status === "cancelled" || p.status === "failed").map((p) => p.id)),
          now: new Date(),
        });
      });
    const first = setTimeout(load, 0);
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [accounts, session.token, version]);

  const mode = workspaceMode(records);
  const schedule = mode === "team" ? ofType(records, "payroll-schedule")[0]?.value : undefined;
  const payday =
    !!vitals && !!schedule && payDay(schedule, paidPeriods(ofType(records, "run").map((r) => r.value), vitals.deadPaymentIds), vitals.now).due;
  const mood: Mood = vitals
    ? petMood({
        accounts: accounts.length,
        totalZats: vitals.totalZats,
        pending: vitals.pending,
        unwell: vitals.unwell,
        celebrate: vitals.celebrate,
        payday,
        hour: vitals.hour,
      })
    : loaded && !accounts.length
      ? "egg"
      : "content";

  return (
    <Ctx.Provider value={{ session, records, accounts, loaded, selected, setSelected, reload, vitals, mood, payday, mode, error }}>
      {children}
    </Ctx.Provider>
  );
}
