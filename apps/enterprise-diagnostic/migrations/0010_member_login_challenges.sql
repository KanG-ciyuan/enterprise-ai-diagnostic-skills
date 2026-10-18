CREATE TABLE IF NOT EXISTS member_login_challenges (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consume_claim TEXT UNIQUE,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  delivery_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_member_login_challenges_account_created
  ON member_login_challenges(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_member_login_challenges_expiry
  ON member_login_challenges(expires_at, consumed_at);
