-- Signed payments are broadcast at a random moment inside a window so pay
-- runs don't form an on-chain timing pattern.
ALTER TABLE payments ADD COLUMN broadcast_at TIMESTAMPTZ;
CREATE INDEX payments_due_idx ON payments (broadcast_at) WHERE status = 'scheduled';
