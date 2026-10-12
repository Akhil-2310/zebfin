-- Month-end kudos settlements are their own payment kind.
ALTER TABLE payments DROP CONSTRAINT payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check
    CHECK (kind IN ('payroll', 'payment', 'refund', 'transfer', 'kudos'));
