# Zebfin

Private finance on Zcash for teams and individuals: payroll, treasury, books, kudos and sealed-bid auctions, end-to-end encrypted. **Testnet only.**

- [backend/](backend/README.md): Rust workspace (signer, view-only wallet, API server, dev CLI)
- [web/](web/): Next.js app; all encryption happens in the browser

## Run locally

```bash
# 1. Postgres (project-local, port 5433; first-time setup is in backend/README.md)
pg_ctl -D .dev/pg -l .dev/pg.log start

# 2. API server (http://localhost:8080)
cd backend && DATABASE_URL=postgres://zebfin@localhost:5433/zebfin ZEBFIN_DATA_DIR=../.dev/server-data cargo run -p zebfin-server

# 3. Browser signer (Wasm; needs `brew install llvm`, `rustup target add wasm32-unknown-unknown`,
#    and `cargo install wasm-bindgen-cli --version <version in Cargo.lock>`)
web/scripts/build-signer.sh

# 4. Web app (http://localhost:3000)
cd web && npm install && npm run dev
```

Optional testnet faucet: add `ZEBFIN_FAUCET_KEY=<testnet signer key file>` and
`ZEBFIN_FAUCET_ACCOUNT=<that key's account id in the wallet service>` to the API server's environment. Treasury then
shows **🚰 Get test TAZ**, which sends `ZEBFIN_FAUCET_TAZ` (default 0.02) from that wallet to a fresh address of the
org's account, once per org per hour. It is the only spending key the server ever holds, it belongs to Zebfin's own
faucet wallet (no org's funds), and the signer refuses non-testnet key files.

Open http://localhost:3000, create an organization with a passkey (Chrome or Safari; the passkey provider must support the WebAuthn PRF extension), save the recovery kit, then connect a treasury account using the view-only key from `zebfin signer export`.

## Deploy (testnet)

Three pieces: Postgres (e.g. Neon, free), the API server (Railway; it must stay running and needs a persistent
volume), and the web app (Vercel).

1. **Postgres:** create a Neon project and copy its connection string (`…?sslmode=require`).
2. **API server on Railway:** New project → *Deploy from GitHub repo* → set the service's root directory to `backend`
   (it builds `backend/Dockerfile` per `backend/railway.toml`). Then:
   - add a **volume** mounted at `/data` (wallet databases and in-flight payments);
   - set variables: `DATABASE_URL`, `ZEBFIN_CORS_ORIGIN=https://<site>.vercel.app`, `ZEBFIN_RP_ID=<site>.vercel.app`,
     and optionally `ZEBFIN_FAUCET_KEY_JSON` (a testnet key file's contents) for the faucet;
   - *Settings → Networking → Generate domain* (port 8080).
   The deploy logs show the faucet's top-up address.
3. **Web app on Vercel:** import the repo with root directory `web`, set `NEXT_PUBLIC_API_URL=https://<api>.up.railway.app`,
   deploy.

- `ZEBFIN_RP_ID` must be the web app's domain, or passkeys won't work. Passkeys made on localhost don't carry over.
- The browser signer (`web/public/signer`, `web/src/wasm`) is committed; rebuild it with `web/scripts/build-signer.sh`
  after changing the signer crates.
- Without `ZEBFIN_FAUCET_ACCOUNT`, the faucet creates its own account on first start and logs an address to fund.
- `backend/fly.toml` is there too if you prefer Fly.io.

## How the web app protects data

| Thing | Where it lives |
|---|---|
| Org key (256-bit) | Generated in the browser. Stored only wrapped: once per passkey (key from the WebAuthn PRF output, which never leaves the browser) and once for the 24-word recovery kit |
| Org name, contributors, account labels | XChaCha20-Poly1305 under the org key, padded to fixed size buckets, bound to org + record ID |
| Recovery kit | Never sent. The server stores an opaque lookup ID and a hash of a verifier derived from the words |
| Passkey display name | Set in the browser; the server only sees a placeholder |
| Approver spending key (seed) | Wrapped under the approver's *own* passkey (not the org key, so other members can't sign). Unwrapped only after a passkey prompt, used by the Wasm signer, then dropped |
| Session | In memory only; reload = one passkey prompt to unlock |

Approvers review a payment decoded **on their device** from the transaction itself (the Wasm signer, 1.3 MB, ~40 ms to sign), never the server's summary. A built transaction expires about 40 blocks (~17 min) after creation, so sign promptly or rebuild the run.

`npx tsx web/scripts/crypto-check.ts` checks the crypto against a running API.

## Payroll privacy and controls (Phase 1)

| Protection | How |
|---|---|
| Team size hidden | Every run is padded with zero-value outputs to the org's own fresh addresses until its shielded action count is a multiple of 8. A 1-, 3- or 7-person run all look like 8 actions; cost is ZIP 317's 5,000 zats per action (40,000 zats per run of up to 7). |
| Two-person rule | A run needs `approval_threshold` (default 2) passkey approvals from different admins/approvers. Each approval is a WebAuthn assertion the server verifies, recorded with the SHA-256 of the exact transaction; the signed transaction is refused until the threshold is met. Enforced by the server until FROST. |
| Timing jitter | After signing, the server broadcasts at a random moment up to 10 minutes later. The window is bounded by the transaction's standard 40-block (~17 min) expiry; we don't lengthen expiry because a non-standard expiry is itself visible on-chain. Fully random pay-day timing needs an online signer (enclave/FROST, Phase 6). |
| No self-payment | Recipients owned by the paying account (checked with its viewing keys) are rejected. |
| Invites | Single-use links; the key material is in the URL fragment, never sent to the server. |

### Phase 1 gate: passed (10 Oct 2026)

Five-person USD payroll run on testnet, tx `cefe1bde25601e6b3f4413d983c0f597c122909f1ba1c73e3095c90cc2282637` (block 4,485,313):

- Priced at a locked $1,226.01/ZEC (Coinbase + Kraken); salaries $2.00–$4.00
- One transaction: 5 payments + 2 padding outputs = 8 shielded actions, 40,000 zat fee
- 2-of-2 approvals, then broadcast at a randomly scheduled moment
- Each of five independent contributor wallets received exactly its amount and decrypted only its own payslip memo; none can see another's pay

## Tests

```bash
# Offline unit tests (signer: payee validation, Orchard-only export, PCZT decode, wrong-seed refusal)
cd backend && cargo test -p zebfin-signer

# Offline ledger unit tests (categorization, transfers, reconciliation, USD values, reports, CSV formats)
cd web && npm test

# Testnet integration suite (server, Postgres and a funded dev org in .dev/ must be up)
cd web && npm run test:testnet            # E2E_FULL=1 also waits for mining + memo decryption
```

The integration suite covers: refusing transparent, own and unaffordable payees; padding 1- and 3-person
runs to 8 actions; note locking (a second run can't take a pending run's notes, cancelling releases them);
dev tokens can't approve; signatures refused without approvals, refused for a different transaction,
accepted once, and not resubmittable; org isolation; portal link checks; and (full mode) mining plus
memo decryption by the recipient. Approvals are inserted directly in Postgres because the passkey
ceremony needs a browser. We chose live testnet over a local regtest network (Zebra + Zaino) to avoid
extra infrastructure; regtest remains an option for CI.

## Books (Phase 2)

The **Books** tab is a ledger built in the browser from each account's viewing-key transaction feed and the org's
encrypted records. The server supplies chain facts and prices; it never computes a balance, total or category.

- **Automatic entries:** every transaction with date, account, direction, counterparty (contributor names for
  payroll), memo, fee, ZEC/USD on the block date and USD value. Padding, change and expired transactions are excluded.
- **Categories:** payroll runs are recognized from encrypted run records; transfers between org accounts are
  detected; rules ("memo contains" / "paid to address") and per-transaction notes are encrypted records.
- **Reconciliation:** the ledger balance is checked against the chain; sent payments missing on chain, unmatched
  incoming payments, uncategorized spending and disputed price days are flagged.
- **Prices:** daily closes from Kraken and Coinbase fetched in bulk (2 years in one request, refreshed every 6 h), so
  price lookups reveal nothing about when the org transacts.
- **Reports:** monthly income / payroll / other spend / fees / net, balance over time, runway at the last 3 months'
  burn, unrealized gain (average cost, approximate; not tax advice).
- **Exports:** QuickBooks 3-column CSV, Xero CSV, full ledger CSV, printable period report; all generated client-side.
- **Period close:** a closed month locks categories and notes; reopening is admin-only in the app; every change goes to
  an encrypted audit trail. These controls are enforced in the client, not by the server.

## Treasury (Phase 3)

| Feature | How it works |
|---|---|
| Payment requests | Anyone on the team can request a payment, transfer or refund. Recipients, amounts and memos are stored on the wallet side; Postgres holds only the content hash and status. |
| Approvals | Passkey approvals bind to the request's content hash, not to a built transaction, so they can take days. Once approved the transaction is built, checked to pay exactly the approved recipients, signed, and rebuilt without re-approval if it expires (~17 min) before signing. |
| Spending policy | Server-enforced approvals. Default for teams adapts to the number of approvers (alone: 1; two: either below \$1,000, both at or above; three or more: a majority); fixed USD tiers are also available, optional daily/monthly caps per account, and a new-payee hold (default: payments over \$500 only to payees in the payee book for 24h). A policy change needs a second admin when there is one. |
| Payee book | Labels are encrypted; the server keeps salted address hashes to enforce the hold. Contributors are added automatically. |
| Accounts | Separate ZIP 32 accounts from one seed (operating, payroll, reserves…), each with its own addresses and viewing key. Transfers between them are checked to land in the org's own account. |
| Invoices | A fresh address per invoice, a ZIP 321 link and QR with the invoice number as memo, matching by receiving address (paid / part-paid / overpaid), an encrypted receipt on the customer's private link, and refunds to a refund address the customer leaves there (refunds go through approvals). |
| Auditor access | A read-only, expiring link (1–90 days, enforced by the server) to one account's books for one period. Auditors never get the org key. Optionally includes that account's viewing key, with the warning that it can't be revoked (move funds to a fresh account to end access). |

### Phase 3 gate: passed (testnet integration suite)

- A payment above a tier can't be built with fewer approvals than the tier requires, and approvals of different content don't count.
- Auditor links are scoped to one account, read-only, must expire, and stop working when they do; viewing keys are admin-only.

## Kudos (Phase 4)

| | |
|---|---|
| Amounts are cryptographically private | Each kudos amount is sealed (X25519 sealed box) to the settler's public key, plus a copy under the giver's passkey-derived personal key so they can track their allowance. Teammates, recipients and our server can't read amounts; the settlement secret is sealed under the settler's passkey. |
| What the team sees | Who thanked whom, the note, the value tag and emoji reactions. Leaderboards (most appreciated, most generous, thanked the most people, per value) count kudos and never sum amounts; members can opt out. |
| Allowance | Monthly per-member USD allowance, tracked by the giver from their own sealed copies. Nothing touches the chain during the month, so unused allowance simply never leaves the treasury. |
| Anti-gaming | No self-kudos, a per-recipient monthly cap applied at settlement, and admins see pairs who thank each other 3+ times each in a month. |
| Badges | First kudos, thanked five teammates, four-week giving streak, most appreciated last month. |
| Settlement | The settler opens the month's amounts, totals and caps them per recipient, and requests one `kudos` payment: padded to 8 actions like payroll, through the usual approvals and passkey signing. Each memo lists that person's thank-yous (within 512 bytes). |
| Treasury health score | 0–100 in Books: books reconcile, everything categorized, two-person approvals, runway over 12 months, last month closed, auditor report this quarter, padding. |

### Phase 4 gate: passed (testnet)

A month of kudos (5 thank-yous, one recipient capped) settled in one 8-action shielded transaction; each of three recipient wallets decrypted only its own thank-yous; a teammate's key and the recipient's key both fail to open someone else's amount.

## Sealed-bid auctions (Phase 5)

Commit-reveal, entirely in shielded memos to the auction's own ZIP 32 account. (Time-lock encryption was the plan's
first choice, but drand-style tlock ciphertexts don't fit in a 512-byte memo alongside a refund address and add an
external beacon dependency; commit-reveal is the plan's fallback.)

| Step | What happens |
|---|---|
| Create | The organizer creates an auction (procurement or sale, first- or second-price, fixed bond, deadlines). It gets its own account derived from the org seed, and a private bidder link. |
| Bid | The bidder page seals the bid locally: `commitment = SHA-256(auction, bid, random salt, refund address)`. The bidder pays the same fixed bond to the auction address with memo `ZBID1|auction|commitment|refund address`, so neither the bond nor the memo says anything about the bid. The bidder keeps a bid file (salt + bid). |
| Reveal | After bidding closes, a tiny payment with memo `ZREV1|auction|commitment|bid|salt`. Reveals before the deadline or after the reveal window don't count. |
| Close | Valid reveals decide the winner (lowest for procurement, highest for a sale; second-price pays the runner-up's bid). Losing bonds are refunded in one padded transaction through the normal approvals; unrevealed bonds are forfeited. |
| Verify | Results are posted to the bidder link; each bidder's browser recomputes every commitment. The organizer can also share the auction account's viewing key (it covers only that account) so bidders can check every bond, reveal and refund on-chain. As the rules state up front, revealed losing bids become visible to participants; a zero-knowledge proof of the result is the long-term replacement. |
