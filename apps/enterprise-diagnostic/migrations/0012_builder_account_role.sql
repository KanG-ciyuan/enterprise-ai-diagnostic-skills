-- PRIV-P1-009: record external-builder standing on the account.
--
-- Why this is needed
-- ------------------
-- POST /api/projects accepted any session whose formalActor role was "account".
-- That role is what formalActor reports whenever no project is bound to the
-- session, which login-consume produces for an account with ZERO active project
-- memberships or with TWO OR MORE. Creating a project inserts an
-- `external_builder` membership for the creator, so such a session could grant
-- itself builder standing without passing the bootstrap-gated
-- /api/auth/authorize path.
--
-- Two real populations reach an account-scoped session:
--   1. a member whose project membership was revoked (zero active memberships)
--   2. an employee who participates in two or more projects
--
-- `accounts` carried no account-level role, so a provisioned builder, a revoked
-- member and a two-project employee were indistinguishable at the login gate.
-- This column makes builder standing explicit at provisioning time, which is the
-- only way to allow case 3 while denying cases 1 and 2.

ALTER TABLE accounts
ADD COLUMN account_role TEXT NOT NULL DEFAULT 'member';

-- Backfill: before this migration the only accounts that could own a project
-- were ones provisioned through authorize, plus any account that reached the
-- gap above. Accounts that already own a project keep builder standing so that
-- existing projects are not silently orphaned. Auditing whether any of those
-- projects were created through the gap is a separate, manual decision and is
-- NOT resolved by this migration.
UPDATE accounts
SET account_role = 'external_builder'
WHERE id IN (
  SELECT DISTINCT created_by_account_id
  FROM projects
  WHERE created_by_account_id IS NOT NULL
);

-- /api/auth/authorize is the only provisioning path for external builders.
-- Invited members are created by the invitation-accept route and keep the
-- 'member' default, regardless of the role they hold inside a project.
--
-- No index on account_role: the value is only ever read for the current
-- session's own account row, which is already a primary-key lookup.
