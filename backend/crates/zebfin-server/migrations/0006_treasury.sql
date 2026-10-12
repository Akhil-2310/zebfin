-- Treasury: approvals bind to the request's content (recipients, amounts,
-- memos), not to one built transaction, so an expired transaction can be
-- rebuilt without re-approval. Request contents and USD values live on the
-- wallet side, not here.
ALTER TABLE payments ADD COLUMN content_hash BYTEA;
ALTER TABLE payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'payment'
    CHECK (kind IN ('payroll', 'payment', 'refund', 'transfer'));
ALTER TABLE payments ADD COLUMN requested_by UUID;
COMMENT ON COLUMN approvals.pczt_hash IS 'SHA-256 of the canonical request contents that were approved';

-- Spending policy, enforced by the server (so stored in plaintext): approval
-- tiers by USD amount, caps, and the new-payee hold. A change proposed by one
-- admin takes effect only when a second admin confirms it (if there is one).
ALTER TABLE orgs ADD COLUMN policy TEXT;
ALTER TABLE orgs ADD COLUMN pending_policy TEXT;
ALTER TABLE orgs ADD COLUMN pending_policy_by UUID;

-- Approved payees, as salted hashes of their addresses (labels stay in
-- encrypted records). Large payments to payees added recently are held.
CREATE TABLE payees (
    org_id UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    address_hash BYTEA NOT NULL,
    added_by UUID,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, address_hash)
);
