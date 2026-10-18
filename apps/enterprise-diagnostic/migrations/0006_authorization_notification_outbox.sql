CREATE TABLE IF NOT EXISTS authorization_notification_outbox (
  notification_id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(authorization_id, token_hash),
  FOREIGN KEY (authorization_id) REFERENCES enterprise_authorizations(id)
);

CREATE INDEX IF NOT EXISTS idx_authorization_outbox_status
ON authorization_notification_outbox(status, updated_at);
