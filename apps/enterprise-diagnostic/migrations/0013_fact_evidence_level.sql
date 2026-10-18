-- V0.1-01: fact-level E1–E5 evidence grade.
--
-- Why this is needed
-- ------------------
-- The evidence model already exists as methodology (E1 observed record, E2
-- corroborated, E3 single statement, E4 policy/intent, E5 model inference or
-- analyst hypothesis) and the employee-mapping adapter already COMPUTES a grade:
--
--   functions/api/agent/_adapter.js  DEFAULT_EVIDENCE_LEVEL = "E3"
--   and it is emitted on every turn at _adapter.js:172 and :259
--
-- But `candidate_facts` had no column to store it, so the computed grade was
-- discarded. The only `evidence_level` column in the schema is on `projects`,
-- it is written once and never read.
--
-- Consequence before this migration: a delivered diagnosis report could not
-- cite an evidence grade per fact. Adding the grade later, in a document, is
-- re-grading outside the verification point in time — that breaks the E1–E5
-- rules rather than implementing them.
--
-- Design notes
-- ------------
-- * `evidence_level` is NULLABLE and historical rows are deliberately left NULL.
--   NULL means "未定级 / not graded". There is NO backfill: writing a grade that
--   nobody decided would be fabricating evidence. A verifier (or later pass)
--   must set the grade explicitly.
-- * The grade is INDEPENDENT of the confirmation state (`status`). A fact can be
--   confirmed with an unknown grade, or graded while still open. The two axes
--   are orthogonal and are constrained separately, not by a combined CHECK.
-- * `evidence_level_source` records HOW the grade came to be, so an operator-set
--   grade is distinguishable from a grading that needs a verifier decision when
--   enforcement is turned on.
-- * `evidence_labeled` marks rows that must always render the "AI假设，待验证"
--   label (E5 / model-inferred). It defaults to 0 so historical rows are not
--   retroactively labelled as AI assumptions.

ALTER TABLE candidate_facts
ADD COLUMN evidence_level TEXT;

ALTER TABLE candidate_facts
ADD COLUMN evidence_level_source TEXT;

ALTER TABLE candidate_facts
ADD COLUMN evidence_labeled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE candidate_facts
ADD COLUMN evidence_level_updated_at TEXT;

ALTER TABLE candidate_facts
ADD COLUMN evidence_level_updated_by_account_id TEXT;

-- Audit index: "which facts were re-graded, by whom, when" must be answerable
-- without scanning the whole table when a published conclusion is challenged.
CREATE INDEX IF NOT EXISTS idx_candidate_facts_evidence_level
ON candidate_facts(project_id, evidence_level);

-- Historical rows intentionally stay NULL. No UPDATE statement here.

-- V0.1-01b companion: audit trail for impact-level changes.
--
-- `impact_level` was previously write-once (set by a regex at fact creation) and
-- there was NO `UPDATE ... impact_level` anywhere in the codebase. A missed
-- high-impact fact therefore could not be corrected, and a corrected one left no
-- trace. These columns record who changed the level, when, and why, so an upgrade
-- is a reviewable act rather than an invisible mutation.

ALTER TABLE candidate_facts
ADD COLUMN impact_level_updated_at TEXT;

ALTER TABLE candidate_facts
ADD COLUMN impact_level_updated_by_account_id TEXT;

ALTER TABLE candidate_facts
ADD COLUMN impact_level_reason TEXT;
