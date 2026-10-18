ALTER TABLE enterprise_authorizations ADD COLUMN authorizer_name TEXT NOT NULL DEFAULT '';
ALTER TABLE enterprise_authorizations ADD COLUMN creation_idempotency_key TEXT NOT NULL DEFAULT '';
ALTER TABLE enterprise_authorizations ADD COLUMN confirmation_token_expires_at TEXT;

UPDATE enterprise_authorizations
SET confirmation_token_nonce='', confirmation_token_hash='', confirmation_token_expires_at='1970-01-01T00:00:00.000Z',
    confirmation_delivery_status='needs_reissue', confirmation_delivery_last_error='Named authorizer and expiring capability required'
WHERE status='pending' AND (authorizer_name='' OR authorizer_email='');

CREATE UNIQUE INDEX IF NOT EXISTS idx_authorization_creation_idempotency
ON enterprise_authorizations(project_id, created_by_account_id, creation_idempotency_key)
WHERE creation_idempotency_key!='';
