-- One row per chat request routed through Switchyard.
CREATE TABLE IF NOT EXISTS requests (
  id              TEXT PRIMARY KEY,
  ts              INTEGER NOT NULL,        -- epoch ms
  session_id      TEXT NOT NULL,
  strategy        TEXT NOT NULL,           -- Switchyard route id
  prompt          TEXT NOT NULL,           -- truncated to 500 chars
  model           TEXT,                    -- model that answered (from upstream response)
  routing_reason  TEXT,                    -- judge reason/evidence, when Switchyard exposes it
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  latency_ms      INTEGER,
  cost_usd        REAL,
  baseline_usd    REAL,                    -- same tokens priced at the baseline (Opus) rates
  success         INTEGER NOT NULL,        -- 1 ok, 0 error
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests (ts);
CREATE INDEX IF NOT EXISTS idx_requests_session_ts ON requests (session_id, ts);
