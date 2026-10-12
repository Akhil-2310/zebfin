// Writes fresh payout addresses from the dev contributor wallets to .env.local,
// for the dashboard's "Load demo data" button (5 contributors + 2 vendors).
// Restart `npm run dev` afterwards so Next picks them up.
//   npm run demo:addresses

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ZEBFIN = path.join(ROOT, "backend/target/debug/zebfin");
const ENV = path.join(ROOT, "web/.env.local");

const address = (i: number) =>
  execFileSync(ZEBFIN, ["wallet", "address", "-w", path.join(ROOT, ".dev", `contributor${i}-wallet`)], { stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();

// Vendors reuse wallets 4 and 5 with new (unlinkable) addresses.
const addresses = [1, 2, 3, 4, 5, 4, 5].map(address);
const line = `NEXT_PUBLIC_DEMO_ADDRESSES=${addresses.join(",")}`;
const current = fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8") : "";
const kept = current.split("\n").filter((l) => l && !l.startsWith("NEXT_PUBLIC_DEMO_ADDRESSES="));
fs.writeFileSync(ENV, [...kept, line].join("\n") + "\n");
console.log(`Wrote ${addresses.length} testnet addresses to web/.env.local. Restart the dev server.`);
