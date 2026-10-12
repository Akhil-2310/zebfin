// Recurring payroll. The schedule is an encrypted record, so our server can't
// see who is paid or when; the app reminds approvers on pay day and pre-fills
// the run. Sending still needs approvals and a passkey signature.

export interface PayrollSchedule {
  type: "payroll-schedule";
  /** Day of the month, 1-28 so every month has it. */
  dayOfMonth: number;
  /** Contributor record ids on the regular run. */
  contributorIds: string[];
}

export interface PayDay {
  /** The period ("YYYY-MM") the next or current run pays. */
  period: string;
  /** Local date of that pay day. */
  date: Date;
  /** Pay day has arrived and that period has no run yet. */
  due: boolean;
  /** Whole days until pay day (0 when due). */
  daysUntil: number;
}

const periodOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * Where we are in the pay cycle. `paidPeriods` are periods that already have a
 * live payroll run (cancelled or failed runs don't count).
 */
export function payDay(schedule: Pick<PayrollSchedule, "dayOfMonth">, paidPeriods: Set<string>, now = new Date()): PayDay {
  const day = Math.min(28, Math.max(1, Math.round(schedule.dayOfMonth)));
  const today = startOfDay(now);
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), day);
  const period = periodOf(thisMonth);
  if (today >= thisMonth && !paidPeriods.has(period)) return { period, date: thisMonth, due: true, daysUntil: 0 };
  const next = today < thisMonth ? thisMonth : new Date(now.getFullYear(), now.getMonth() + 1, day);
  return {
    period: periodOf(next),
    date: next,
    due: false,
    daysUntil: Math.round((next.getTime() - today.getTime()) / 864e5),
  };
}

/** Periods with a live payroll run; runs whose payment was cancelled or failed don't count. */
export function paidPeriods(runs: { period: string; paymentId: string; kind?: string }[], deadPaymentIds: Set<string>): Set<string> {
  return new Set(runs.filter((r) => (r.kind ?? "payroll") === "payroll" && !deadPaymentIds.has(r.paymentId)).map((r) => r.period));
}

export const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
};
