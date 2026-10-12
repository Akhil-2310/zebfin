-- Passkey login. A member is an opaque ID; their name and role live in an
-- encrypted record. The passkey's user name shown in password managers is set
-- by the browser and never reaches the server.

CREATE TABLE members (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE passkeys (
    cred_id BYTEA PRIMARY KEY,
    member_id UUID NOT NULL REFERENCES members (id) ON DELETE CASCADE,
    -- webauthn-rs `Passkey` (public key + counter), JSON.
    passkey TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

CREATE TABLE sessions (
    token_hash BYTEA PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES members (id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recovery kit login. The browser derives a lookup ID and a 256-bit verifier
-- from the 24-word recovery code; the server stores the lookup ID and the
-- SHA-256 of the verifier, never the words. The same words separately unwrap
-- the org key in the browser.
CREATE TABLE recovery_kits (
    lookup_id BYTEA PRIMARY KEY,
    verifier_hash BYTEA NOT NULL,
    org_id UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES members (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
