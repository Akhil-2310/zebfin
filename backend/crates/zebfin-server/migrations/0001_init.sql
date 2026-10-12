-- Zebfin app database. Rule 2: this database holds ciphertext only.
-- Plaintext columns are limited to random IDs, timestamps and the minimum
-- routing state the server needs (payment status, txid).

CREATE TABLE orgs (
    id UUID PRIMARY KEY,
    -- Org name, settings etc., encrypted in the browser under the org key.
    meta_ciphertext BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Temporary bearer tokens until passkey sessions land. Only the SHA-256 of
-- each token is stored.
CREATE TABLE api_tokens (
    token_hash BYTEA PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The org key wrapped for each member (under a passkey-PRF-derived key) or
-- for the recovery kit. key_version increments on rotation after member removal.
CREATE TABLE wrapped_keys (
    org_id UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    member_id UUID NOT NULL,
    key_version INTEGER NOT NULL,
    ciphertext BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, member_id, key_version)
);

-- Every app record (contributors, invoices, ledger entries, kudos, ...) is an
-- opaque blob under a random ID. No type column: the browser keeps its own
-- index inside the ciphertext so the server can't learn structure.
CREATE TABLE records (
    org_id UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    id UUID NOT NULL,
    ciphertext BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id)
);

-- A Zcash account managed by the view-only wallet service. The account's name
-- and purpose live in an encrypted record; this row only routes requests.
CREATE TABLE accounts (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Payment lifecycle. Payees, amounts and memos are NOT stored here; they live
-- only in the wallet service's PCZT files (the future enclave).
CREATE TABLE payments (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    txid TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payments_account_idx ON payments (account_id, created_at DESC);
