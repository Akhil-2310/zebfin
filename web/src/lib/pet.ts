// The treasury pet's mood, derived from the org's real financial state.

export type Mood = "egg" | "hungry" | "sick" | "busy" | "happy" | "content" | "sleepy" | "party" | "payday";

export interface PetState {
  accounts: number;
  /** Total balance across accounts, in zatoshis (null = unknown yet). */
  totalZats: number | null;
  /** Payments waiting on approvals, building or signing. */
  pending: number;
  /** Books problems: ledger/chain mismatch or sent payments missing on chain. */
  unwell?: boolean;
  /** 0-100 treasury health, when known. */
  health?: number | null;
  /** A scheduled payroll is due and not yet requested. */
  payday?: boolean;
  /** A payment just confirmed. */
  celebrate?: boolean;
  hour?: number;
}

export function petMood(s: PetState): Mood {
  if (s.accounts === 0) return "egg";
  if (s.celebrate) return "party";
  if (s.unwell) return "sick";
  if (s.totalZats === 0) return "hungry";
  if (s.payday) return "payday";
  if (s.pending > 0) return "busy";
  const hour = s.hour ?? new Date().getHours();
  if (hour >= 0 && hour < 6) return "sleepy";
  if (s.health != null) return s.health >= 70 ? "happy" : "content";
  return "happy";
}

const LINES: Record<Mood, string[]> = {
  egg: ["Connect a treasury account to hatch me!", "I'm warm in here. Give me an account and I'll hatch."],
  hungry: ["I'm hungry! Feed me some testnet TAZ.", "Treasury's empty. A faucet snack would be lovely."],
  sick: ["Something's off in the books. Check reconciliation?", "I don't feel balanced. The ledger needs a look."],
  busy: ["Payments are waiting on approvals or a signature.", "I'm holding a payment for you. Approve it?"],
  happy: ["All shielded, all encrypted. Life is good.", "Nobody can see our payroll. I love it here."],
  content: ["Things are fine. A few habits would make me happier.", "Close last month's books for a health boost?"],
  sleepy: ["Zzz… payments still go out shielded while I nap.", "It's late. I'm guarding the treasury in my sleep."],
  party: ["A payment just landed on chain! 🎉", "Confirmed and shielded. Nice work!"],
  payday: ["It's pay day! The run is ready in Payroll. Review it and request it.", "Pay day! Let's pay the team, privately."],
};

/** A friendly line for the speech bubble (stable for a given seed). */
export function petLine(mood: Mood, seed = 0): string {
  const lines = LINES[mood];
  return lines[Math.abs(seed) % lines.length];
}

export const MOOD_LABEL: Record<Mood, string> = {
  egg: "Egg",
  hungry: "Hungry",
  sick: "Unwell",
  busy: "Busy",
  happy: "Happy",
  content: "Content",
  sleepy: "Sleepy",
  party: "Party",
  payday: "Pay day",
};
