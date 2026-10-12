// Kudos logic. Pure functions over decrypted records; everything that's shown
// to the team is computed from counts, never amounts.

import type { Kudos } from "./records";

export const DEFAULT_TAGS = ["Shipping", "Helping", "Mentoring", "Customer care"];

type K = Pick<Kudos, "from" | "to" | "tag" | "month" | "at">;

export interface Leader {
  memberId: string;
  count: number;
}

const top = (counts: Map<string, number>, hidden: Set<string>, n = 3): Leader[] =>
  [...counts.entries()]
    .filter(([id]) => !hidden.has(id))
    .map(([memberId, count]) => ({ memberId, count }))
    .sort((a, b) => b.count - a.count || a.memberId.localeCompare(b.memberId))
    .slice(0, n);

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Count-only leaderboards for one month. Members who opted out are omitted. */
export function leaderboards(kudos: K[], month: string, hidden: Set<string> = new Set()) {
  const inMonth = kudos.filter((k) => k.month === month && k.from !== k.to);
  const received = new Map<string, number>();
  const given = new Map<string, number>();
  const helped = new Map<string, Set<string>>();
  const byTag = new Map<string, Map<string, number>>();
  for (const k of inMonth) {
    bump(received, k.to);
    bump(given, k.from);
    helped.set(k.from, (helped.get(k.from) ?? new Set()).add(k.to));
    if (!byTag.has(k.tag)) byTag.set(k.tag, new Map());
    bump(byTag.get(k.tag)!, k.to);
  }
  return {
    mostAppreciated: top(received, hidden),
    mostGenerous: top(given, hidden),
    mostDiverse: top(new Map([...helped].map(([id, s]) => [id, s.size])), hidden),
    byTag: [...byTag.entries()].map(([tag, m]) => ({ tag, leaders: top(m, hidden, 1) })),
  };
}

/** ISO week key, used for giving streaks. */
function weekKey(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 864e5 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Consecutive weeks (ending this week or last) in which the member gave kudos. */
export function givingStreak(kudos: K[], memberId: string, now = new Date()): number {
  const weeks = new Set(kudos.filter((k) => k.from === memberId).map((k) => weekKey(k.at)));
  let streak = 0;
  const cursor = new Date(now);
  if (!weeks.has(weekKey(cursor.toISOString()))) cursor.setUTCDate(cursor.getUTCDate() - 7);
  while (weeks.has(weekKey(cursor.toISOString()))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }
  return streak;
}

export interface Badge {
  id: string;
  label: string;
  earned: boolean;
}

export function badges(kudos: K[], memberId: string, now = new Date()): Badge[] {
  const given = kudos.filter((k) => k.from === memberId && k.to !== memberId);
  const teammates = new Set(given.map((k) => k.to));
  const month = now.toISOString().slice(0, 7);
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const mvp = leaderboards(kudos, lastMonth).mostAppreciated[0]?.memberId === memberId;
  return [
    { id: "first", label: "First kudos given", earned: given.length > 0 },
    { id: "five", label: "Thanked five teammates", earned: teammates.size >= 5 },
    { id: "streak", label: "Four-week giving streak", earned: givingStreak(kudos, memberId, now) >= 4 },
    { id: "mvp", label: `Most appreciated in ${lastMonth}`, earned: mvp },
    { id: "received", label: "Thanked by a teammate this month", earned: kudos.some((k) => k.to === memberId && k.month === month) },
  ];
}

/**
 * Pairs who thank each other unusually often in a month (both directions at
 * least `threshold` times): shown to admins as a possible allowance loop.
 */
export function reciprocalFlags(kudos: K[], month: string, threshold = 3): [string, string][] {
  const pair = new Map<string, number>();
  for (const k of kudos.filter((x) => x.month === month)) bump(pair, `${k.from}>${k.to}`);
  const flags: [string, string][] = [];
  for (const [key, n] of pair) {
    const [a, b] = key.split(">");
    if (a < b && n >= threshold && (pair.get(`${b}>${a}`) ?? 0) >= threshold) flags.push([a, b]);
  }
  return flags;
}

export interface SettlementLine {
  memberId: string;
  usd: number;
  capped: boolean;
  notes: { from: string; note: string }[];
}

/**
 * Month-end totals per recipient from the settler's decrypted amounts, with
 * self-kudos dropped and each recipient capped.
 */
export function settlementTotals(
  kudos: (K & { note: string; usd: number })[],
  month: string,
  capUsd: number,
): SettlementLine[] {
  const lines = new Map<string, SettlementLine>();
  for (const k of kudos) {
    if (k.month !== month || k.from === k.to || !(k.usd > 0)) continue;
    const l = lines.get(k.to) ?? { memberId: k.to, usd: 0, capped: false, notes: [] };
    l.usd += k.usd;
    l.notes.push({ from: k.from, note: k.note });
    lines.set(k.to, l);
  }
  return [...lines.values()].map((l) => (l.usd > capUsd ? { ...l, usd: capUsd, capped: true } : l));
}

/** A memo listing the notes, kept within Zcash's 512-byte memo limit. */
export function kudosMemo(month: string, line: SettlementLine, nameOf: (id: string) => string): string {
  const enc = new TextEncoder();
  let memo = `Zebfin kudos | ${month} | ${line.notes.length} thank-you${line.notes.length === 1 ? "" : "s"}`;
  for (const n of line.notes) {
    const piece = ` | ${nameOf(n.from)}: "${n.note}"`;
    if (enc.encode(memo + piece).length > 500) {
      memo += " | …";
      break;
    }
    memo += piece;
  }
  while (enc.encode(memo).length > 512) memo = memo.slice(0, -1);
  return memo;
}
