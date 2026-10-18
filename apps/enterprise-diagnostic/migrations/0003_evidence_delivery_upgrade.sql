-- Assumption: 0002 is the first production evidence-registry migration.
-- This migration upgrades 0002 and the matching preview ensureSchema layout.
ALTER TABLE enterprise_authorizations ADD COLUMN authorizer_email TEXT NOT NULL DEFAULT '';
ALTER TABLE enterprise_authorizations ADD COLUMN confirmation_token_nonce TEXT NOT NULL DEFAULT '';
ALTER TABLE enterprise_authorizations ADD COLUMN confirmation_delivery_status TEXT NOT NULL DEFAULT 'needs_reissue';
ALTER TABLE enterprise_authorizations ADD COLUMN confirmation_delivery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enterprise_authorizations ADD COLUMN confirmation_delivery_last_error TEXT;
ALTER TABLE enterprise_authorizations ADD COLUMN confirmation_delivery_last_attempt_at TEXT;

UPDATE enterprise_authorizations
SET status='pending', token_consumed_at=NULL, confirmation_delivery_status='needs_reissue',
    confirmation_delivery_last_error='Legacy preview authorization requires addressed reissue'
WHERE status!='pending'
  AND (confirmed_by_identity IS NULL OR confirmed_at IS NULL OR confirmation_reason IS NULL);

UPDATE evidence_materials
SET integrity_status='pending'
WHERE integrity_status!='pending'
  AND (reviewed_by_account_id IS NULL OR reviewed_at IS NULL OR review_reason IS NULL);

UPDATE evidence_materials
SET authorization_status='pending'
WHERE authorization_record_id IS NULL
   OR authorization_record_id IN (SELECT id FROM enterprise_authorizations WHERE status!='authorized');
