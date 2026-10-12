// Offline tests for kudos logic and the sealed-box crypto. Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { newBoxKeypair, openPersonal, openSealed, randomBytes, sealPersonal, sealTo } from "../src/lib/crypto";
import { badges, givingStreak, kudosMemo, leaderboards, reciprocalFlags, settlementTotals } from "../src/lib/kudos";

const k = (from: string, to: string, at: string, tag = "Helping") => ({ from, to, tag, at, month: at.slice(0, 7) });

test("sealed amounts open only with the settler's secret; personal copies only with the giver's key", () => {
  const settler = newBoxKeypair();
  const sealed = sealTo(settler.publicKey, { usd: 7.5 }, "kudos|abc");
  assert.deepEqual(openSealed(settler.secretKey, sealed, "kudos|abc"), { usd: 7.5 });
  assert.throws(() => openSealed(newBoxKeypair().secretKey, sealed, "kudos|abc"), "another member can't open it");
  assert.throws(() => openSealed(settler.secretKey, sealed, "kudos|other"), "bound to its record");

  const mine = randomBytes(32);
  const copy = sealPersonal(mine, { usd: 7.5 }, "kudos|abc");
  assert.deepEqual(openPersonal(mine, copy, "kudos|abc"), { usd: 7.5 });
  assert.throws(() => openPersonal(randomBytes(32), copy, "kudos|abc"));
});

test("leaderboards count kudos (never sum amounts), ignore self-kudos and honour opt-outs", () => {
  const ks = [
    k("a", "b", "2026-10-02T10:00:00Z"),
    k("c", "b", "2026-10-03T10:00:00Z", "Shipping"),
    k("a", "c", "2026-10-04T10:00:00Z"),
    k("a", "a", "2026-10-04T11:00:00Z"), // self
    k("d", "b", "2026-09-30T10:00:00Z"), // other month
  ];
  const lb = leaderboards(ks, "2026-10");
  assert.deepEqual(lb.mostAppreciated[0], { memberId: "b", count: 2 });
  assert.deepEqual(lb.mostGenerous[0], { memberId: "a", count: 2 });
  assert.deepEqual(lb.mostDiverse[0], { memberId: "a", count: 2 });
  assert.equal(lb.byTag.find((t) => t.tag === "Shipping")!.leaders[0].memberId, "b");
  const hidden = leaderboards(ks, "2026-10", new Set(["b"]));
  assert.ok(!hidden.mostAppreciated.some((l) => l.memberId === "b"));
  for (const board of [lb.mostAppreciated, lb.mostGenerous, lb.mostDiverse]) {
    for (const row of board) assert.deepEqual(Object.keys(row).sort(), ["count", "memberId"], "no amounts");
  }
});

test("streaks, badges and reciprocal-loop flags", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const weekly = ["2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28"].map((d) => k("a", "b", `${d}T09:00:00Z`));
  assert.equal(givingStreak(weekly, "a", now), 4);
  assert.equal(givingStreak(weekly.slice(0, 2), "a", now), 0, "gap breaks it");
  const b = badges(weekly, "a", now);
  assert.ok(b.find((x) => x.id === "streak")!.earned);
  assert.ok(b.find((x) => x.id === "first")!.earned);
  assert.ok(!b.find((x) => x.id === "five")!.earned);

  const loop = [...Array(3)].flatMap((_, i) => [k("x", "y", `2026-10-0${i + 1}T00:00:00Z`), k("y", "x", `2026-10-0${i + 1}T01:00:00Z`)]);
  assert.deepEqual(reciprocalFlags(loop, "2026-10"), [["x", "y"]]);
  assert.deepEqual(reciprocalFlags(loop.slice(0, 4), "2026-10"), []);
});

test("settlement totals per recipient, cap, no self-kudos; memo fits 512 bytes", () => {
  const ks = [
    { ...k("a", "b", "2026-10-02T00:00:00Z"), note: "great demo", usd: 15 },
    { ...k("c", "b", "2026-10-03T00:00:00Z"), note: "fixed prod", usd: 20 },
    { ...k("a", "c", "2026-10-03T00:00:00Z"), note: "thanks", usd: 5 },
    { ...k("a", "a", "2026-10-03T00:00:00Z"), note: "me", usd: 50 },
  ];
  const lines = settlementTotals(ks, "2026-10", 25);
  const b = lines.find((l) => l.memberId === "b")!;
  assert.equal(b.usd, 25);
  assert.ok(b.capped);
  assert.equal(lines.find((l) => l.memberId === "c")!.usd, 5);
  assert.ok(!lines.some((l) => l.memberId === "a"), "self-kudos never paid");

  const long = { memberId: "b", usd: 1, capped: false, notes: Array.from({ length: 40 }, () => ({ from: "a", note: "x".repeat(60) })) };
  const memo = kudosMemo("2026-10", long, () => "Alice");
  assert.ok(new TextEncoder().encode(memo).length <= 512);
  assert.ok(memo.startsWith("Zebfin kudos | 2026-10 | 40 thank-yous"));
});

import { healthScore } from "../src/lib/health";

test("health score sums earned achievements to 100 at most", () => {
  const perfect = healthScore({ ledgerMatchesChain: true, missingOnChain: 0, needsReview: 0, sentPayments: [{ approvals: 2 }], runwayMonths: 18, lastMonthClosed: true, auditSharedThisQuarter: true });
  assert.equal(perfect.score, 100);
  const weak = healthScore({ ledgerMatchesChain: false, missingOnChain: 1, needsReview: 4, sentPayments: [{ approvals: 1 }], runwayMonths: 2, lastMonthClosed: false, auditSharedThisQuarter: false });
  assert.equal(weak.score, 5, "only padding, which Zebfin always does");
});
