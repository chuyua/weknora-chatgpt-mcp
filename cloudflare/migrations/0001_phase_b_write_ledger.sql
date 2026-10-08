-- Phase B append-only operational audit and fail-closed idempotency.
-- Stores metadata/digests only; never persist Markdown, credentials or tokens.
CREATE TABLE IF NOT EXISTS weknora_write_ops (
  operation_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN ('create','update')),
  kb_id TEXT NOT NULL,
  knowledge_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved','sent','success','uncertain','rejected')),
  result_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_weknora_ops_kb_created ON weknora_write_ops(kb_id,created_at);
CREATE TABLE IF NOT EXISTS weknora_write_locks (
  knowledge_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS weknora_write_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  kb_id TEXT NOT NULL,
  knowledge_id TEXT,
  event TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_weknora_audit_operation ON weknora_write_audit(operation_id,seq);
