-- Auction links: bidders read the rules and (after close) the results.
ALTER TABLE portals DROP CONSTRAINT portals_kind_check;
ALTER TABLE portals ADD CONSTRAINT portals_kind_check
    CHECK (kind IN ('contributor', 'invoice', 'audit', 'auction'));
