PRAGMA foreign_keys = ON;

-- Deployment boundary: this chain has not been deployed. A database that
-- already ran an older preview migration without these foreign keys requires
-- a separately approved, data-preserving remediation instead of table rebuilds.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  created_by_role TEXT NOT NULL,
  created_by_account_id TEXT
);

CREATE TABLE IF NOT EXISTS enterprises (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  authorization_status TEXT NOT NULL DEFAULT 'authorized',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  enterprise_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_memberships (
  project_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(project_id, account_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  inviter_account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  accepted_account_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, inviter_account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  project_id TEXT,
  expires_at TEXT NOT NULL,
  refresh_token TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  account_id TEXT NOT NULL,
  project_id TEXT,
  action TEXT NOT NULL,
  request_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(account_id, project_id, action, request_key)
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  assignee_role TEXT NOT NULL,
  assignee_label TEXT NOT NULL,
  evidence_completeness INTEGER NOT NULL,
  blocking_reason TEXT NOT NULL,
  next_action TEXT NOT NULL,
  employee_description TEXT NOT NULL DEFAULT '',
  assignee_account_id TEXT,
  source_employee_account_id TEXT,
  employee_draft_json TEXT NOT NULL DEFAULT '{}',
  material_status TEXT NOT NULL DEFAULT 'undecided',
  workflow_card_json TEXT NOT NULL DEFAULT '{}',
  candidate_fact_id TEXT,
  flow_card_version INTEGER NOT NULL DEFAULT 1,
  evidence_version INTEGER NOT NULL DEFAULT 1,
  assigned_verifier_id TEXT,
  submission_version INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  handoff_status TEXT NOT NULL DEFAULT 'not_submitted',
  last_submission_key TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  alternative_explanations_json TEXT NOT NULL DEFAULT '[]',
  judgment_status TEXT NOT NULL DEFAULT 'open',
  supplement_id TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  work_item_id TEXT,
  type TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  contract_version TEXT,
  run_id TEXT,
  member_id TEXT,
  role TEXT,
  version INTEGER,
  reason TEXT,
  source_refs TEXT,
  authorization TEXT,
  idempotency_key TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS fact_judgments (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  correction TEXT,
  source_refs TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  flow_card_version INTEGER NOT NULL,
  evidence_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS evidence_supplements (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  requested_material TEXT NOT NULL,
  responsible_person TEXT NOT NULL,
  responsible_account_id TEXT,
  deadline TEXT NOT NULL,
  recovery_entry TEXT NOT NULL,
  authorization_scope TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  old_evidence_version INTEGER NOT NULL,
  new_evidence_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  material TEXT,
  material_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  provided_at TEXT
);

CREATE TABLE IF NOT EXISTS decision_packets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  drafted_by_account_id TEXT NOT NULL,
  verifier_account_id TEXT,
  fact_refs_json TEXT NOT NULL,
  risk_summary TEXT NOT NULL,
  pilot_scope TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  success_metrics_json TEXT NOT NULL,
  stop_conditions_json TEXT NOT NULL,
  downstream_owner TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at TEXT,
  published_at TEXT,
  UNIQUE(project_id, version),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS owner_decisions (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  scope TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  success_metrics_json TEXT NOT NULL,
  stop_conditions_json TEXT NOT NULL,
  downstream_owner TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (packet_id) REFERENCES decision_packets(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_work_items_project_stage
ON work_items(project_id, stage);
CREATE INDEX IF NOT EXISTS idx_events_project_created
ON events(project_id, id);
CREATE INDEX IF NOT EXISTS idx_decision_packets_project_version
ON decision_packets(project_id, version DESC);
