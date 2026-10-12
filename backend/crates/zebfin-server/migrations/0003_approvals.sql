-- Roles, invites and payment approvals. Roles and the approval threshold are
-- stored in plaintext because the server enforces them; member names stay in
-- encrypted records.

ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'
    CHECK (role IN ('admin', 'approver', 'member'));

ALTER TABLE orgs ADD COLUMN approval_threshold INTEGER NOT NULL DEFAULT 2
    CHECK (approval_threshold >= 1);

-- An invite link carries a secret in its URL fragment, which never reaches
-- the server. The browser derives a verifier from it; we store its SHA-256.
CREATE TABLE invites (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'approver', 'member')),
    verifier_hash BYTEA NOT NULL,
    created_by UUID NOT NULL REFERENCES members (id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_by UUID REFERENCES members (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A passkey-verified approval of one exact payment transaction.
CREATE TABLE approvals (
    payment_id UUID NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES members (id) ON DELETE CASCADE,
    -- SHA-256 of the created PCZT the member reviewed and approved.
    pczt_hash BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (payment_id, member_id)
);
