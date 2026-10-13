// Two ready-made spending policies: a founder running the org alone, or a team
// whose approvals adapt to its size (enforced by the server).

import type { Policy } from "./api";

export type Preset = "solo" | "team";

const NEW_PAYEE_HOLD = { new_payee_hold_above_usd: 500, new_payee_hold_hours: 24 };

export const PRESETS: Record<Preset, { label: string; blurb: string; policy: Policy }> = {
  solo: {
    label: "Just me",
    blurb: "One founder approves and signs every payment. Pay as many people as you like.",
    policy: { adaptive: false, tiers: [{ above_usd: 0, approvals: 1 }], daily_cap_usd: null, monthly_cap_usd: null, ...NEW_PAYEE_HOLD },
  },
  team: {
    label: "Several of us",
    blurb: "Adapts to your team: with two of you, either approves under $1,000 and both above; with three or more, a majority.",
    policy: {
      adaptive: true,
      tiers: [
        { above_usd: 0, approvals: 2 },
        { above_usd: 10_000, approvals: 3 },
      ],
      daily_cap_usd: null,
      monthly_cap_usd: null,
      ...NEW_PAYEE_HOLD,
    },
  },
};

/** Under adaptive approvals, two approvers each approve payments below this alone. */
export const ADAPTIVE_SOLO_LIMIT_USD = 1_000;

/** Approvals a payment of `usd` needs with `approvers` people (mirrors the server). */
export function adaptiveApprovals(approvers: number, usd: number | null): number {
  if (approvers <= 1) return 1;
  if (approvers === 2) return usd !== null && usd < ADAPTIVE_SOLO_LIMIT_USD ? 1 : 2;
  return Math.floor(approvers / 2) + 1;
}

/** Which preset a policy's approval rule matches, if any (caps and holds may differ). */
export function presetOf(p: Policy): Preset | null {
  if (p.adaptive) return "team";
  const key = (q: Policy) => JSON.stringify([...q.tiers].sort((a, b) => a.above_usd - b.above_usd));
  return key(PRESETS.solo.policy) === key(p) ? "solo" : null;
}

/** Most approvals any payment can need (adaptive: with `approvers` people). */
export const maxApprovals = (p: Policy, approvers = 2) =>
  p.adaptive ? adaptiveApprovals(approvers, null) : Math.max(...p.tiers.map((t) => t.approvals));
