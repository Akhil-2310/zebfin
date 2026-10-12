-- Contributor portals: a private channel between the org and one contributor,
-- opened by a link whose secret (URL fragment) never reaches the server. All
-- content is encrypted under a key derived from that secret; contributors
-- never get the org key.
CREATE TABLE portals (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    verifier_hash BYTEA NOT NULL,
    -- Org -> contributor: who is asking (org name, contributor name), encrypted.
    card_ciphertext BYTEA NOT NULL,
    -- Contributor -> org: their payout address, encrypted.
    response_ciphertext BYTEA,
    response_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Org -> contributor: payslips, encrypted.
CREATE TABLE portal_items (
    portal_id UUID NOT NULL REFERENCES portals (id) ON DELETE CASCADE,
    id UUID NOT NULL,
    ciphertext BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (portal_id, id)
);
