-- Append-only audit trail: one row per MCP tool call, allowed or not.
-- Stores call metadata only, never returned record data.
CREATE TABLE audit_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    request_id     TEXT    NOT NULL,
    identity       TEXT    NOT NULL,
    tool           TEXT    NOT NULL,
    arguments      TEXT,
    decision       TEXT    NOT NULL CHECK (decision IN ('allow', 'deny', 'error')),
    reason         TEXT,
    result_summary TEXT,
    duration_ms    INTEGER
);

CREATE INDEX idx_audit_ts       ON audit_log (ts);
CREATE INDEX idx_audit_identity ON audit_log (identity, ts);

