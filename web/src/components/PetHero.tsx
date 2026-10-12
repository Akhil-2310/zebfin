"use client";

import { Pet } from "@/components/Pet";
import { useAppData } from "@/lib/app-data";
import { MOOD_LABEL, petLine } from "@/lib/pet";

/** The Home page's handheld "device": Zeb, what it's saying, and its meters. */
export function PetHero() {
  const { session, mood, vitals: v } = useAppData();
  // "Food" fills on a log scale: 0.001 TAZ is a crumb, 1 TAZ is a feast.
  const food = v?.totalZats ? Math.max(5, Math.min(100, ((Math.log10(v.totalZats / 1e8) + 3) / 3) * 100)) : 0;
  const calm = v ? Math.max(10, 100 - v.pending * 25) : 100;

  return (
    <section className="card overflow-hidden p-4 sm:p-6" style={{ background: "var(--accent-soft)" }}>
      <div className="grid items-center gap-5 md:grid-cols-[1fr_minmax(220px,300px)]">
        <div className="flex items-center gap-4">
          <div className="screen flex shrink-0 items-end justify-center px-3 pb-1 pt-4 sm:px-6 sm:pb-2 sm:pt-5">
            <span className="hidden sm:block">
              <Pet mood={mood} size={112} />
            </span>
            <span className="sm:hidden">
              <Pet mood={mood} size={72} />
            </span>
          </div>
          <div className="bubble bubble-left min-w-0 max-w-md">
            <span className="display mr-2 block text-xs uppercase tracking-wide text-muted">Zeb · {MOOD_LABEL[mood]}</span>
            <span>{petLine(mood, session.orgName.length)}</span>
          </div>
        </div>
        <div className="screen space-y-2 text-xs">
          <div className="flex items-baseline justify-between">
            <span>BALANCE</span>
            <span className="text-sm">{v?.totalZats != null ? `${(v.totalZats / 1e8).toFixed(4)} TAZ` : "—"}</span>
          </div>
          {v?.usd != null && <div className="-mt-1 text-right opacity-70">≈ ${v.usd.toFixed(2)}</div>}
          <Meter label="FOOD" value={food} color="var(--chart-1)" />
          <Meter label="CALM" value={calm} color="var(--ok)" />
          <Meter label="PRIVACY" value={100} color="var(--accent-strong)" note="shielded only" />
        </div>
      </div>
    </section>
  );
}

function Meter({ label, value, color, note }: { label: string; value: number; color: string; note?: string }) {
  return (
    <div>
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="opacity-70">{note ?? `${Math.round(value)}%`}</span>
      </div>
      <div className="meter mt-0.5" role="meter" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${value}%`, color }} />
      </div>
    </div>
  );
}
