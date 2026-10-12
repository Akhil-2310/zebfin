// Two ready-made spending policies: a founder running the org alone, or a team
// where no single person can move money.

import type { Policy } from "./api";

export type Preset = "solo" | "team";

const NEW_PAYEE_HOLD = { new_payee_hold_above_usd: 500, new_payee_hold_hours: 24 };

export const PRESETS: Record<Preset, { label: string; blurb: string; policy: Policy }> = {
  solo: {
    label: "Just me",
    blurb: "One founder approves and signs every payment. Pay as many people as you like.",
    policy: { tiers: [{ above_usd: 0, approvals: 1 }], daily_cap_usd: null, monthly_cap_usd: null, ...NEW_PAYEE_HOLD },
  },
  team: {
    label: "Several of us",
    blurb: "Two people approve every payment, three above $10,000. Nobody can move money alone.",
    policy: {
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

/** Which preset a policy's approval tiers match, if any (caps and holds may differ). */
export function presetOf(p: Policy): Preset | null {
  const key = (q: Policy) => JSON.stringify([...q.tiers].sort((a, b) => a.above_usd - b.above_usd));
  return (Object.keys(PRESETS) as Preset[]).find((k) => key(PRESETS[k].policy) === key(p)) ?? null;
}

/** Most approvals any payment can need. */
export const maxApprovals = (p: Policy) => Math.max(...p.tiers.map((t) => t.approvals));
