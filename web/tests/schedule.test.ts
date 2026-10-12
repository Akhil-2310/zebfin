import assert from "node:assert/strict";
import { test } from "node:test";
import { ordinal, payDay } from "../src/lib/schedule";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

test("before pay day: not due, counts down to this month's date", () => {
  const p = payDay({ dayOfMonth: 25 }, new Set(), at(2026, 10, 20));
  assert.equal(p.due, false);
  assert.equal(p.period, "2026-10");
  assert.equal(p.daysUntil, 5);
});

test("on and after pay day: due until that period has a run", () => {
  assert.equal(payDay({ dayOfMonth: 25 }, new Set(), at(2026, 10, 25, 0)).due, true);
  const late = payDay({ dayOfMonth: 25 }, new Set(), at(2026, 10, 30));
  assert.equal(late.due, true);
  assert.equal(late.period, "2026-10");
});

test("once this period is paid, the next pay day is next month (across the year end)", () => {
  const p = payDay({ dayOfMonth: 10 }, new Set(["2026-12"]), at(2026, 12, 15));
  assert.equal(p.due, false);
  assert.equal(p.period, "2027-01");
  assert.equal(p.daysUntil, 26);
});

test("pay day is clamped to 1-28", () => {
  assert.equal(payDay({ dayOfMonth: 31 }, new Set(), at(2026, 2, 28)).due, true);
  assert.equal(payDay({ dayOfMonth: 0 }, new Set(), at(2026, 3, 1)).due, true);
});

test("ordinals", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 28].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "28th"]);
});
