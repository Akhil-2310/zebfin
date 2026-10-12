// Treasury health score: achievements for good financial habits, computed in
// the browser from the books. Weights sum to 100.

export interface HealthInput {
  ledgerMatchesChain: boolean;
  missingOnChain: number;
  needsReview: number;
  /** Sent payments (broadcast or mined) with their approval counts. */
  sentPayments: { approvals: number }[];
  runwayMonths: number | null;
  lastMonthClosed: boolean;
  auditSharedThisQuarter: boolean;
}

export interface Achievement {
  id: string;
  label: string;
  weight: number;
  earned: boolean;
  hint: string;
}

export function healthScore(h: HealthInput): { score: number; achievements: Achievement[] } {
  const achievements: Achievement[] = [
    {
      id: "reconciled",
      label: "Books reconcile with the chain",
      weight: 25,
      earned: h.ledgerMatchesChain && h.missingOnChain === 0,
      hint: "Ledger balance equals the chain and no sent payment is missing.",
    },
    {
      id: "categorized",
      label: "Everything categorized",
      weight: 15,
      earned: h.needsReview === 0,
      hint: "Review flagged entries in the ledger.",
    },
    {
      id: "two-person",
      label: "Every payment had two or more approvals",
      weight: 20,
      earned: h.sentPayments.every((p) => p.approvals >= 2),
      hint: "Keep at least two approvals on every tier of the spending policy.",
    },
    {
      id: "runway",
      label: "Runway above 12 months",
      weight: 15,
      earned: (h.runwayMonths ?? 0) > 12,
      hint: "Balance covers a year at the last three months' burn.",
    },
    {
      id: "closed",
      label: "Last month closed",
      weight: 10,
      earned: h.lastMonthClosed,
      hint: "Close last month in the monthly report once reviewed.",
    },
    {
      id: "audited",
      label: "Auditor report shared this quarter",
      weight: 10,
      earned: h.auditSharedThisQuarter,
      hint: "Share a scoped, expiring audit link.",
    },
    {
      id: "padded",
      label: "Every transaction padded and shielded",
      weight: 5,
      earned: true,
      hint: "Zebfin pads every run to 8 shielded actions.",
    },
  ];
  return { score: achievements.reduce((s, a) => s + (a.earned ? a.weight : 0), 0), achievements };
}
