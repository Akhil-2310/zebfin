// "Load demo data": fills a fresh org with a believable team so a demo has
// something to show. Testnet only. Everything is created in the browser through
// the same paths as the UI, so it's encrypted under the org key like real data.
// Re-running skips whatever already exists.

import { api, post, type MembersResponse, type RateQuote } from "./api";
import type { AuctionRules } from "./auction";
import { createSiblingAccount } from "./accounts";
import { fromB64, newBoxKeypair, newId, sealPersonal, sealTo, toB64 } from "./crypto";
import { zip321Uri } from "./invoices";
import { DEFAULT_TAGS } from "./kudos";
import { createPortal } from "./portal";
import { ofType, saveRecord, ZATS_PER_TAZ, type Contributor, type Stored } from "./records";
import type { Session } from "./session";
import { hasSigningKey } from "./signer";
import type { WorkspaceMode } from "./workspace";

/**
 * Payout addresses for the demo team, from the dev contributor wallets
 * (`npm run demo:addresses` writes them to .env.local). Without them,
 * contributors are created waiting for an address, like an invite.
 */
const DEMO_ADDRESSES = (process.env.NEXT_PUBLIC_DEMO_ADDRESSES ?? "").split(",").filter(Boolean);

// Small USD amounts: a testnet faucet only gives so much TAZ.
const TEAM: [string, string, number][] = [
  ["Alice Moreau", "Protocol engineer", 4],
  ["Bob Okafor", "Frontend", 3.5],
  ["Chen Wei", "Operations", 3],
  ["Dana Ruiz", "Design", 2.5],
  ["Eli Novak", "Community", 2],
];
const VENDORS = ["Nimbus Hosting", "Pixel & Co (design studio)"];

const thisMonth = () => new Date().toISOString().slice(0, 7);

async function registerPayee(session: Session, address: string, label: string) {
  try {
    await post("/v1/payees", { address }, session.token);
    await saveRecord(session, { type: "payee", address, label });
  } catch {}
}

export async function loadDemoData(
  session: Session,
  accounts: string[],
  records: Stored[],
  progress: (step: string) => void,
  mode: WorkspaceMode = "team",
): Promise<string[]> {
  const done: string[] = [];
  const team = mode === "team";
  // The first addresses are the team's payout addresses, the rest are vendors'.
  const teamAddresses = DEMO_ADDRESSES.slice(0, TEAM.length);
  const vendorAddresses = DEMO_ADDRESSES.slice(TEAM.length);
  const accountId = accounts[0];

  // 1. The team.
  const existing = new Set(ofType(records, "contributor").map((c) => c.value.name));
  let added = 0;
  const teamIds = ofType(records, "contributor").map((c) => c.id);
  for (const [i, [name, role, usd]] of TEAM.entries()) {
    const address = teamAddresses[i] ?? "";
    if (existing.has(name)) continue;
    progress(`Adding ${name}…`);
    const c: Contributor = { type: "contributor", name, role, address, payCurrency: "USD", monthlyTaz: 0, monthlyUsd: usd };
    const { portalId, secret } = await createPortal(session, { orgName: session.orgName, contributorName: name, role });
    teamIds.push(await saveRecord(session, { ...c, portalId, portalSecret: secret }));
    if (address) await registerPayee(session, address, name);
    added++;
  }
  if (added) done.push(`${added} contributors${DEMO_ADDRESSES.length ? "" : " (waiting for payout addresses)"}`);

  // A regular pay day. Today's date, so the demo opens on "Pay day!".
  if (!ofType(records, "payroll-schedule").length && DEMO_ADDRESSES.length) {
    await saveRecord(session, { type: "payroll-schedule", dayOfMonth: Math.min(28, new Date().getDate()), contributorIds: teamIds });
    done.push("a monthly pay day (today)");
  }

  // 2. Vendors in the payee book.
  const payees = new Set(ofType(records, "payee").map((p) => p.value.label));
  added = 0;
  for (const [i, label] of VENDORS.entries()) {
    const address = vendorAddresses[i];
    if (!address || payees.has(label)) continue;
    progress(`Adding payee ${label}…`);
    await registerPayee(session, address, label);
    added++;
  }
  if (added) done.push(`${added} vendor payees`);

  // 3. Bookkeeping rules.
  if (!ofType(records, "rule").length) {
    await saveRecord(session, { type: "rule", match: "memo", value: "hosting", category: "Software" });
    await saveRecord(session, { type: "rule", match: "memo", value: "design", category: "Contractors" });
    done.push("bookkeeping rules");
  }

  if (!accountId) {
    done.push(`connect a treasury account and load again for an invoice${team ? ", kudos" : ""} and an auction`);
    return done;
  }

  // 4. An invoice with a QR code.
  const invoices = ofType(records, "invoice");
  if (!invoices.length) {
    progress("Creating an invoice…");
    const quote = await api<RateQuote>("/v1/rates/zec-usd", { token: session.token });
    const usdAmount = 5;
    const zats = Math.round((usdAmount / quote.usd_per_zec) * ZATS_PER_TAZ);
    const { address } = await post<{ address: string }>(`/v1/accounts/${accountId}/addresses`, {}, session.token);
    const number = "INV-0001";
    const customer = "Globex Corp";
    const description = "Smart-contract audit consultation";
    const dueDate = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const uri = zip321Uri(address, zats, `${session.orgName} ${number}`, `${session.orgName} invoice ${number}`);
    const { portalId, secret } = await createPortal(session, {
      kind: "invoice",
      orgName: session.orgName,
      number,
      customer,
      description,
      usdAmount,
      usdPerZec: quote.usd_per_zec,
      zats,
      address,
      uri,
      dueDate,
    });
    await saveRecord(session, {
      type: "invoice",
      number,
      customer,
      description,
      usdAmount,
      usdPerZec: quote.usd_per_zec,
      zats,
      address,
      dueDate,
      createdAt: new Date().toISOString(),
      accountId,
      portalId,
      portalSecret: secret,
    });
    done.push("an invoice");
  }

  // 5. Kudos, plus a thank-you to each teammate already on board.
  let settings = ofType(records, "kudos-settings")[0]?.value;
  if (team && !settings && session.personalKey.length) {
    progress("Starting kudos…");
    const kp = newBoxKeypair();
    settings = {
      type: "kudos-settings",
      monthlyAllowanceUsd: 20,
      perRecipientCapUsd: 10,
      tags: DEFAULT_TAGS,
      accountId,
      settlerMemberId: session.memberId,
      settlementPublicKey: toB64(kp.publicKey),
      settlementSecretSealed: sealPersonal(session.personalKey, { sk: toB64(kp.secretKey) }, "kudos-settlement-key"),
    };
    await saveRecord(session, settings);
    done.push("kudos");
  }
  if (team && settings && session.personalKey.length && !ofType(records, "kudos").some((k) => k.value.from === session.memberId)) {
    const members = await api<MembersResponse>("/v1/members", { token: session.token });
    const notes = ["Thanks for jumping on the release blocker!", "Great review on the payroll flow."];
    for (const [i, m] of members.members.filter((m) => !m.is_me).slice(0, 2).entries()) {
      const id = newId();
      const usd = 5;
      await saveRecord(
        session,
        {
          type: "kudos",
          from: session.memberId,
          to: m.member_id,
          note: notes[i],
          tag: DEFAULT_TAGS[i],
          month: thisMonth(),
          at: new Date().toISOString(),
          amountForSettler: sealTo(fromB64(settings.settlementPublicKey), { usd }, `kudos|${id}`),
          amountForGiver: sealPersonal(session.personalKey, { usd }, `kudos|${id}`),
        },
        id,
      );
      if (i === 0) done.push("kudos to your teammates");
    }
  }

  // 6. A sealed-bid auction in its own account (asks for your passkey once).
  if (!ofType(records, "auction").length) {
    const keyed = (await Promise.all(accounts.map(async (a) => ((await hasSigningKey(session, a)) ? a : null)))).find(Boolean);
    if (keyed) {
      progress("Creating an auction (approve with your passkey)…");
      const title = "Logo and brand refresh";
      const labels = ofType(records, "account");
      const auctionAccount = await createSiblingAccount(session, keyed, `Auction: ${title}`, labels);
      const { address } = await post<{ address: string }>(`/v1/accounts/${auctionAccount}/addresses`, {}, session.token);
      const biddingEndsAt = new Date(Date.now() + 2 * 864e5).toISOString();
      const rules: AuctionRules = {
        auctionId: newId(),
        title,
        description: "Design studios bid to deliver a new logo and brand kit. Lowest bid wins; bids stay sealed until close.",
        kind: "procurement",
        pricing: "first-price",
        bondZats: Math.round(0.0005 * ZATS_PER_TAZ),
        biddingEndsAt,
        revealEndsAt: new Date(Date.parse(biddingEndsAt) + 24 * 3600_000).toISOString(),
        address,
      };
      const { portalId, secret } = await createPortal(session, { kind: "auction", orgName: session.orgName, rules }, { kind: "auction" });
      await saveRecord(session, { type: "auction", rules, accountId: auctionAccount, portalId, portalSecret: secret });
      done.push("a sealed-bid auction");
    } else {
      done.push("no auction: it needs an account whose key is in this browser");
    }
  }
  return done.length ? done : ["nothing new; the demo data is already here"];
}
