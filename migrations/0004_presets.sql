-- Admin-selected cost/quality preset (one row: key = 'preset'), and the preset each request used.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_ts INTEGER NOT NULL);
ALTER TABLE requests ADD COLUMN preset TEXT;
