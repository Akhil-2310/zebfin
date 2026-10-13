<p align="center"><img src="web/public/brand/zebfin-logo.svg" alt="Zebfin" height="72"></p>

# Zebfin

**The private finance super app for Zcash.** Payroll, treasury, books, kudos and sealed-bid auctions in one app:
shielded on chain, encrypted off it, and signed only by you.

On public blockchains every salary, balance, vendor and bid is visible to anyone, forever. Zebfin lets a team (or a
single founder) run its money without publishing it. Payments are shielded Zcash transactions padded so headcount
never leaks; every record is encrypted in the browser with keys our server never sees; and payments are signed with
the approver's passkey, so the server can build payments but can't spend.

**Who it's for:** crypto-native startups and remote teams paying contributors worldwide, grant programs paying
grantees and keeping auditable books, small businesses invoicing customers, and individuals (freelancers, anyone
running a private auction).

> Runs on **Zcash testnet** (TAZ). No real funds.

## Links

| | |
|---|---|
| 🌐 Live app | https://zebfin.vercel.app |
| 🎤 Pitch | https://youtu.be/UndB9ZADmME |
| 🎬 Product demo | https://youtu.be/vcKYoEkOrfg |

## What we built

### The app

| Module | What it does |
|---|---|
| 💸 **Payroll** | Contributors with USD or TAZ salaries; one shielded transaction pays everyone, each with an encrypted payslip memo only they can read and a private portal link (payslip + PDF). USD salaries are converted at a rate locked from two exchanges. A monthly **pay day** pre-fills the run and Zeb reminds you. |
| 🏦 **Treasury** | Accounts created in the browser (key locked to your passkey), imported from a seed, or view-only with an external signer. Separate accounts per purpose (operating, payroll, reserves) from one seed. Fresh receiving address every time, QR codes, and a **🚰 Get test TAZ** faucet button on testnet. |
| 🧾 **Payments** | One-off payments to a payee book with an encrypted reason/memo, transfers between your own accounts, refunds. Everything goes through approvals. |
| 📄 **Invoices** | A fresh address per invoice, a ZIP 321 payment link + QR, a private customer link, automatic matching (paid / part-paid / overpaid), encrypted receipts and refunds. |
| 📒 **Books** | A ledger built in the browser from viewing keys: automatic categories and rules, reconciliation with the chain, USD at each day's closing price, monthly reports, QuickBooks / Xero / full CSV exports, a printable period report, month close with an audit trail, a treasury health score, and expiring read-only **auditor links**. |
| 💖 **Kudos** | Teammates thank each other with small amounts from a monthly allowance. Everyone sees who thanked whom; amounts are sealed so only the giver and the settler can read them. Leaderboards, badges, and a monthly settlement in one padded transaction. |
| 🔨 **Sealed-bid auctions** | Procurement or sale, first- or second-price. Bids are committed on chain in shielded memos and can't be read by anyone (the organizer included) until bidding closes. Anyone can bid from a link with any shielded wallet; bonds stop spam; losing bonds are refunded; results are verifiable. |
| 🐣 **Zeb** | A treasury pet whose mood follows your real finances: egg, hungry, busy, pay day, unwell, sleepy, happy, party. Plus a Care guide that walks a new workspace through setup and a one-click **Load demo data**. |

### Workspaces and approvals

- **Personal or team.** Sign-up asks "What's this for?". Personal workspaces include everything except kudos; team
  workspaces add teammates with shared approvals.
- **Roles.** Admins and approvers approve; members can request payments and give kudos.
- **Adaptive approvals (default for teams).** One approver: 1. Two: either approves under \$1,000, both at or above.
  Three or more: a majority. Recomputed by the server as people join or leave, so a policy never asks for more people
  than you have. Fixed USD tiers are also available.
- **Spending policy.** Optional daily/monthly caps per account; a new-payee safety check (payments over \$500 to a
  payee added in the last 24 h wait until the 24 h are up); a policy change needs a second admin when there is one.

### How a payment works

1. **Request:** anyone requests a payment (payroll, payment, transfer, refund).
2. **Approve:** approvers approve with their passkeys. Each approval covers the exact recipients, amounts and memos
   (a content hash), so changing anything voids it.
3. **Build:** the server builds and proves a **PCZT** (partially created Zcash transaction) with a view-only key. It
   cannot spend.
4. **Sign:** the approver's browser decodes the PCZT itself with our Wasm signer (never trusting the server's summary)
   and signs with a seed that is unlocked by their passkey only for that moment.
5. **Send:** immediately, or at a random moment within a few minutes so pay-day timing doesn't form a pattern.

### Privacy techniques

| Technique | How |
|---|---|
| Shielded only | Orchard-protocol (Orchard / Ironwood) spends and outputs; transparent and Sapling payees are refused. |
| Headcount hidden | Every run is padded with zero-value outputs to the org's own fresh addresses until its shielded action count is a multiple of 8, so a 1-, 3- or 7-person run all look like 8 actions. |
| No address reuse | A fresh address for every receipt, invoice and auction; padding goes to fresh addresses. |
| Timing jitter | Broadcast at a random moment, bounded by the transaction's standard ~17-minute expiry (a longer expiry would itself be a fingerprint). |
| Price lookups leak nothing | Daily prices are fetched in bulk (two years at a time) from Kraken and Coinbase, not per payment. |
| Encrypted memos | Payslips, kudos settlements and auction bids ride in memos only the recipient can decrypt. |

### Architecture

```
Browser (Next.js)                         Server (Rust, axum)                       Zcash testnet
───────────────────                       ───────────────────                       ─────────────
passkeys (WebAuthn + PRF)                 Postgres: ciphertext + metadata only       lightwalletd
org key, records: XChaCha20-Poly1305  ──▶ view-only wallet service (librustzcash) ─▶ (testnet.zec.rocks)
Wasm signer (zebfin-signer)               PCZT build + prove, broadcast, sync
books, kudos, auctions computed here      policy + approvals, portals, rates, faucet
```

- **backend/** (Rust workspace): `zebfin-signer` (PCZT signing for Orchard and Ironwood, payee checks),
  `zebfin-wallet` (view-only wallet: sync, padded PCZT builds, proving, broadcast), `zebfin-server` (API),
  `zebfin-signer-wasm` (the signer in the browser), `zebfin-cli` (dev tool).
- **web/** (Next.js): all encryption, decryption, books, kudos and auction logic run in the browser.
- Built on librustzcash pre-release crates that know testnet's NU6.3 (Ironwood) and NU7 upgrades.

### Verified on testnet

- Five-person USD payroll in one transaction, padded to 8 actions; each of five independent wallets received exactly
  its amount and decrypted only its own payslip: `cefe1bde25601e6b3f4413d983c0f597c122909f1ba1c73e3095c90cc2282637`.
- A browser-signed payroll with the Wasm signer, a kudos settlement in one padded transaction, and live auctions
  (bond → reveal → winner).
- **Automated tests:** 24 web unit tests (ledger, invoices, kudos, auctions, pay-day schedule), 16 integration tests
  against the live testnet (padding, note locking, approvals bound to content, signatures refused without approvals
  or for a different transaction, org isolation, portal checks, new-payee holds, auditor scopes, kudos), and Rust unit
  tests for the signer and the spending policy.

## Data: who can see what

| Who | Can see | Can't see |
|---|---|---|
| **The public** (anyone on the chain) | That a shielded transaction happened, roughly when, its fee and its (padded) number of actions | Amounts, senders, recipients, memos, balances, team size |
| **Our database** (Postgres) | Same-sized encrypted blobs; IDs, roles, payment status and timestamps, payment kind, approval counts, the spending policy (the server enforces it), salted hashes of payee addresses | Names, salaries, contributors, categories, notes, invoices, rules, books, kudos notes and amounts |
| **Our wallet service** (view-only key) | Your accounts' transactions: amounts, the addresses it pays, memos (payroll memos include names), balances. It must, to scan the chain and build payments | Your other records; it **cannot spend** |
| **Your workspace members** | Everything the workspace key decrypts (roles limit actions, not visibility) | Kudos amounts (sealed to the giver and the settler) |
| **A contributor** | Their own payslips through their private link | Anyone else's pay, the books |
| **An auditor** | The one account and period you shared, read-only, until the link expires | Everything else |

### Where each secret lives

| Thing | Where it lives |
|---|---|
| Workspace key (256-bit) | Generated in the browser. Stored only wrapped: once per passkey (a key from the WebAuthn PRF output, which never leaves the browser) and once for the 24-word recovery kit |
| Records (names, contributors, labels, books…) | XChaCha20-Poly1305 under the workspace key, padded to fixed-size buckets, bound to the org and record ID |
| Recovery kit | Never sent. The server stores an opaque lookup ID and a hash of a verifier derived from the words |
| Treasury spending key (seed) | Wrapped under the approver's own passkey (not the workspace key, so other members can't sign). Unwrapped only after a passkey prompt, used by the Wasm signer, then dropped. Another passkey can be added with **Treasury → Add signing key** |
| Session | In memory only; reloading locks the workspace until the next passkey prompt |
| Invite and portal links | The key material is in the URL fragment, never sent to the server |

### Honest limits

- **Approvals are enforced by our server.** Anyone holding a treasury seed could sign alone; FROST threshold signing
  would make the rule cryptographic.
- **The wallet service sees payment details** (it builds them). Planned: run it in a hardware enclave, or self-host it.
- **Commit-reveal auctions** show revealed losing bids to participants after close (stated in the rules up front).
- **Testnet only**, on pre-release Zcash libraries. Mainnet needs a security audit, stable libraries and our own node.

## Run locally

Requirements: Rust 1.88+, Node.js, Postgres, and (only to rebuild the browser signer) Homebrew `llvm`, the
`wasm32-unknown-unknown` target and `wasm-bindgen-cli` matching `backend/Cargo.lock`.

```bash
# 1. Postgres (project-local, port 5433; first-time setup is in backend/README.md)
pg_ctl -D .dev/pg -l .dev/pg.log start

# 2. API server (http://localhost:8080)
cd backend && DATABASE_URL=postgres://zebfin@localhost:5433/zebfin ZEBFIN_DATA_DIR=../.dev/server-data cargo run -p zebfin-server

# 3. Browser signer (already committed; rebuild only after changing the signer crates)
web/scripts/build-signer.sh

# 4. Web app (http://localhost:3000)
cd web && npm install && npm run dev
```

Open http://localhost:3000 → **Hatch your workspace** → create a passkey (Chrome or Safari; the passkey provider must
support the WebAuthn PRF extension) → save the recovery kit → **Treasury → New key in this browser** → fund it →
**Home → Load demo data**.

**Testnet faucet (optional).** Add `ZEBFIN_FAUCET_KEY=<testnet key file>` (or `ZEBFIN_FAUCET_KEY_JSON=<its contents>`)
to the API server's environment. Treasury then shows **🚰 Get test TAZ**, sending `ZEBFIN_FAUCET_TAZ` (default 0.02)
to a fresh address of the workspace's account, once per workspace per hour. Without `ZEBFIN_FAUCET_ACCOUNT`, the
faucet creates its own account on first start and logs an address to fund. It is the only spending key the server
ever holds, it belongs to Zebfin's own faucet wallet, and the signer refuses non-testnet key files.

**Demo data addresses (optional).** `cd web && npm run demo:addresses` writes payout addresses from the dev test
wallets to `web/.env.local`, so **Load demo data** adds contributors who can actually be paid. `npm run demo:fund --
<address> 0.05` sends TAZ from the dev wallet.

### Tests

```bash
cd backend && cargo test -p zebfin-signer -p zebfin-server   # signer and policy unit tests
cd web && npm test                                             # ledger, invoices, kudos, auctions, schedule
cd web && npm run test:testnet                                 # live testnet suite (server, Postgres, funded dev org)
```

### Deploy

Three pieces: Postgres (e.g. Neon), the API server (Railway; it must stay running and needs a persistent volume), and
the web app (Vercel).

1. **Postgres:** create a Neon project and copy its direct connection string (`…?sslmode=require`).
2. **API server on Railway:** *Deploy from GitHub repo* with root directory `backend` (builds `backend/Dockerfile`
   per `backend/railway.toml`), add a volume at `/data`, set `DATABASE_URL`, `ZEBFIN_CORS_ORIGIN=https://<site>.vercel.app`,
   `ZEBFIN_RP_ID=<site>.vercel.app` and optionally `ZEBFIN_FAUCET_KEY_JSON`, then generate a domain (port 8080).
3. **Web app on Vercel:** import the repo with root directory `web`, set `NEXT_PUBLIC_API_URL=https://<api>.up.railway.app`
   (and optionally `NEXT_PUBLIC_DEMO_ADDRESSES`), deploy.

`ZEBFIN_RP_ID` must be the web app's domain or passkeys won't work; passkeys made on localhost don't carry over.
`backend/fly.toml` is there if you prefer Fly.io.
