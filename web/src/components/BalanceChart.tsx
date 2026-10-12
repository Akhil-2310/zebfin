"use client";

import { useMemo, useState } from "react";
import { formatTaz } from "@/lib/records";

const W = 640;
const H = 180;
const PAD = { top: 12, right: 12, bottom: 24, left: 56 };

/** Single-series balance over time: 2px line, recessive grid, crosshair tooltip. */
export function BalanceChart({ series }: { series: { date: string; zats: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    if (series.length === 0) return null;
    const t = series.map((p) => Date.parse(p.date));
    const t0 = Math.min(...t);
    const t1 = Math.max(...t, t0 + 86_400_000);
    const maxZ = Math.max(...series.map((p) => p.zats), 1);
    const x = (ms: number) => PAD.left + ((ms - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (z: number) => H - PAD.bottom - (z / maxZ) * (H - PAD.top - PAD.bottom);
    // Step line: a balance holds until the next transaction.
    let d = "";
    series.forEach((p, i) => {
      const px = x(t[i]);
      const py = y(p.zats);
      d += i === 0 ? `M${px},${py}` : `H${px}V${py}`;
    });
    d += `H${W - PAD.right}`;
    const ticks = [0, 0.5, 1].map((f) => ({ z: maxZ * f, y: y(maxZ * f) }));
    return { pts: series.map((p, i) => ({ ...p, x: x(t[i]), y: y(p.zats) })), d, ticks };
  }, [series]);

  if (!geom) return <p className="text-sm text-muted">No confirmed transactions yet.</p>;
  const h = hover !== null ? geom.pts[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Treasury balance over time"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const mx = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          geom.pts.forEach((p, i) => {
            if (Math.abs(p.x - mx) < Math.abs(geom.pts[best].x - mx)) best = i;
          });
          setHover(best);
        }}
      >
        {geom.ticks.map((t) => (
          <g key={t.y}>
            <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} style={{ stroke: "var(--chart-grid)" }} strokeWidth={1} />
            <text x={PAD.left - 6} y={t.y + 3} textAnchor="end" fontSize={10} style={{ fill: "var(--muted)" }}>
              {formatTaz(t.z)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 6} fontSize={10} style={{ fill: "var(--muted)" }}>
          {geom.pts[0].date}
        </text>
        <text x={W - PAD.right} y={H - 6} fontSize={10} textAnchor="end" style={{ fill: "var(--muted)" }}>
          {geom.pts.at(-1)!.date}
        </text>
        <path d={geom.d} fill="none" style={{ stroke: "var(--chart-1)" }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {h && (
          <>
            <line x1={h.x} x2={h.x} y1={PAD.top} y2={H - PAD.bottom} style={{ stroke: "var(--muted)" }} strokeWidth={1} strokeDasharray="2 3" />
            <circle cx={h.x} cy={h.y} r={4} style={{ fill: "var(--chart-1)", stroke: "var(--surface)" }} strokeWidth={2} />
          </>
        )}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-lg border-2 border-border bg-surface px-2 py-1 text-xs"
          style={{ left: `${(h.x / W) * 100}%`, top: 0 }}
        >
          <span className="text-muted">{h.date}</span> · <span className="tabular-nums">{formatTaz(h.zats)} TAZ</span>
        </div>
      )}
    </div>
  );
}
