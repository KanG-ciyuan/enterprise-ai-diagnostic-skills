-- Apply once through Cloudflare D1's tracked migration ledger. This migration
-- intentionally fails if run manually against a database that already has the
-- column, preventing an untracked partial replay from hiding deployment drift.
ALTER TABLE projects ADD COLUMN authorization_stage TEXT NOT NULL DEFAULT 'draft';

UPDATE projects
SET authorization_stage='authorized', status='active'
WHERE EXISTS (
  SELECT 1 FROM enterprise_authorizations
  WHERE enterprise_authorizations.project_id=projects.id
    AND enterprise_authorizations.status='authorized'
);

CREATE INDEX IF NOT EXISTS idx_projects_authorization_stage
ON projects(authorization_stage);
