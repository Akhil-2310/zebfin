-- Time-limited portals (auditor packages). After expires_at the server
-- refuses to serve the portal; read-only portals refuse responses.
ALTER TABLE portals ADD COLUMN kind TEXT NOT NULL DEFAULT 'contributor'
    CHECK (kind IN ('contributor', 'invoice', 'audit'));
ALTER TABLE portals ADD COLUMN expires_at TIMESTAMPTZ;
