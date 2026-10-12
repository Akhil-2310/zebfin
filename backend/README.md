# Zebfin backend (Phase 0)

Rust workspace for Zebfin's Zcash layer. **Testnet only.**

| Crate | Role | Holds |
|---|---|---|
| `zebfin-signer` | Approver's device: shows what a PCZT pays, signs it | Spending key (seed) |
| `zebfin-wallet` | Backend: sync, fresh addresses, build + prove PCZTs, broadcast | Viewing key only |
| `zebfin-cli` | `zebfin` dev CLI wrapping both | — |
| `zebfin-server` | HTTP API: ciphertext-only record store + view-only wallet service | Viewing keys (wallet side only) |

`zebfin-signer` has no networking or storage dependencies so it can later compile to Wasm for in-browser signing.

## Privacy rules enforced in code

- Accounts are imported with an **Orchard-only UFVK** (no Sapling or transparent components), so the backend can never derive a transparent or Sapling receiver.
- Fresh addresses are Orchard-only diversified Unified Addresses; every call returns a new one.
- Payees without an Orchard receiver, or on a non-testnet network, are rejected.
- The signer refuses PCZTs that spend Sapling or transparent funds.
- After NU6.3 (active on testnet since block 4,134,000) Orchard-receiver payments and change land in the **Ironwood** pool; the signer signs both Orchard and Ironwood spends.

## Why pre-release crates

Testnet activated **NU7 at block 4,465,026 (4 Oct 2026)**, which cut block time to 25s. The stable 0.24-series crates (and zcash-devtool `main`, as of 10 Oct) don't know this height, so they build transactions with the old consensus branch ID that today's testnet rejects. We pin the first pre-releases that set it (`zcash_protocol 0.11.0-pre.0`, `zcash_client_backend 0.25.0-pre.1`, ...). Wallet DBs created by the 0.22 `zcash_client_sqlite` don't migrate; recreate them.

Some testnet services (e.g. Fauzec as of 10 Oct) are still on the stale pre-NU7 chain. Use `zebfin wallet lookup-tx <txid>` to check whether testnet.zec.rocks has seen a transaction.

## Build

```bash
cargo build
```

## Phase 0 flow (zcash-devtool PCZT pattern)

Dev data lives in `../.dev/` (git-ignored).

```bash
Z=target/debug/zebfin

# 1. Approver device: create a seed, export the view-only account
$Z signer new --key ../.dev/approver1.json

# 2. Backend: import the viewing key, sync, get a fresh receiving address
$Z wallet import -w ../.dev/backend-wallet --ufvk <ufvk> --seed-fingerprint <fp>
$Z wallet sync -w ../.dev/backend-wallet
$Z wallet address -w ../.dev/backend-wallet     # fund this with testnet TAZ

# 3. Backend: create the payment (multiple --to allowed) and prove it
$Z pczt create -w ../.dev/backend-wallet --to '<utest1...>:100000:Payslip Oct 2026' --output ../.dev/run.created
$Z pczt prove ../.dev/run.created --output ../.dev/run.proven

# 4. Approver device: review and sign the *created* PCZT
$Z signer sign --key ../.dev/approver1.json ../.dev/run.created --output ../.dev/run.signed

# 5. Backend: combine, extract, broadcast
$Z pczt send -w ../.dev/backend-wallet --proven ../.dev/run.proven --signed ../.dev/run.signed

# 6. Recipient: sync and read the memo
$Z wallet sync -w ../.dev/contributor1-wallet && $Z wallet history -w ../.dev/contributor1-wallet
```

Default server is `https://testnet.zec.rocks:443`; override with `--server`.

`wallet sync` scans compact blocks, then fetches the full transactions the wallet needs ("enhancement") so received memos become readable. Fetching by txid reveals interest in those txids to the server; production should use our own node or Tor.

## Phase 0 payment gate: passed (10 Oct 2026)

- Faucet funds: `1fa34609…a937d` (0.125 TAZ, Ironwood, block 4,483,066)
- Payroll payment: `480c4dc8eb52897f81e24ebc3e28bd1c7aa382a2cd60a7ba633b76b3741ae08e` (block 4,483,083). Created and proven by the view-only backend, signed by the approver device, 2 Ironwood actions, 10,000 zat fee.
- Contributor wallet decrypted the payslip memo; the org wallet reads the same memo via its outgoing viewing key.

## API server (`zebfin-server`)

Two stores, deliberately separate:

- **App database (Postgres):** encrypted blobs under random IDs, plus routing state (payment status, txid). No names, salaries, addresses, amounts or memos. Note: txids are stored in plaintext, which would let a database thief link the org to its (shielded) transactions' timing and shape; encrypting them is a TODO.
- **Wallet service (`ZEBFIN_DATA_DIR`):** one view-only SQLite wallet and PCZT directory per account. It sees payees and amounts because it builds transactions; this is the part the plan moves into an enclave.

### Run locally

```bash
# one-time: project-local Postgres on :5433 (data in ../.dev/pg)
initdb -D ../.dev/pg -U zebfin --auth=trust
echo "port = 5433" >> ../.dev/pg/postgresql.conf
pg_ctl -D ../.dev/pg -l ../.dev/pg.log start
createdb -h localhost -p 5433 -U zebfin zebfin

DATABASE_URL=postgres://zebfin@localhost:5433/zebfin ZEBFIN_DATA_DIR=../.dev/server-data \
  cargo run -p zebfin-server
```

Env: `DATABASE_URL`, `ZEBFIN_DATA_DIR` (`./data`), `ZEBFIN_LIGHTWALLETD` (testnet.zec.rocks), `ZEBFIN_BIND` (`127.0.0.1:8080`), `ZEBFIN_CORS_ORIGIN` (`http://localhost:3000`), `ZEBFIN_SYNC_SECS` (30; background sync of every account).

### Endpoints

Auth is a temporary org-scoped bearer token (`Authorization: Bearer <token>`) returned once by `POST /v1/orgs`; only its SHA-256 is stored. Passkey sessions replace it with the web app. Binary fields are base64.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness |
| POST | `/v1/orgs` | Create org `{meta_ciphertext}` → `{org_id, token}` |
| GET/PUT | `/v1/org` | Read/replace encrypted org metadata |
| GET | `/v1/keys` | Wrapped org keys for all members |
| PUT | `/v1/keys/{member_id}/{key_version}` | Store a wrapped org key `{ciphertext}` |
| DELETE | `/v1/keys/{member_id}` | Remove a member's wrapped keys (browser must rotate + re-encrypt) |
| GET | `/v1/records` | All encrypted records (browser filters locally) |
| GET/PUT/DELETE | `/v1/records/{id}` | One encrypted record `{ciphertext}` |
| GET/POST | `/v1/accounts` | List / import view-only account `{ufvk, seed_fingerprint, account_index, birthday?}` |
| POST | `/v1/accounts/{id}/sync` | Sync now → balance |
| GET | `/v1/accounts/{id}/balance` | Balance |
| POST | `/v1/accounts/{id}/addresses` | Fresh Orchard-only address |
| GET | `/v1/accounts/{id}/history` | Outputs with decrypted memos |
| GET/POST | `/v1/accounts/{id}/payments` | List / create payment `{recipients:[{address, value_zats, memo?}]}` |
| GET | `/v1/payments/{id}` | Status, summary and the created PCZT to sign |
| POST | `/v1/payments/{id}/signature` | Submit the device-signed PCZT `{pczt}` → combine + broadcast |

Payment status: `proving` → `awaiting_signature` → `broadcast` → `mined` (or `failed`). The approver's device must recompute the summary from the PCZT itself rather than trust the server's `summary` field.
