PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS enterprise_authorizations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL,
  reference TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_by_account_id TEXT NOT NULL,
  confirmation_token_hash TEXT NOT NULL, token_consumed_at TEXT,
  confirmed_by_identity TEXT, confirmed_at TEXT, confirmation_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS evidence_materials (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL, source_type TEXT NOT NULL,
  authorization_record_id TEXT, authorization_status TEXT NOT NULL DEFAULT 'pending',
  integrity_status TEXT NOT NULL DEFAULT 'pending', visibility TEXT NOT NULL DEFAULT 'project',
  created_by_account_id TEXT NOT NULL, work_item_id TEXT, label TEXT NOT NULL, reference TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}', reviewed_by_account_id TEXT, reviewed_at TEXT, review_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, id, version),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (authorization_record_id) REFERENCES enterprise_authorizations(id)
);
CREATE TABLE IF NOT EXISTS candidate_facts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_item_id TEXT NOT NULL, fact_type TEXT NOT NULL,
  claim TEXT NOT NULL, source_field TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 1,
  impact_level TEXT NOT NULL DEFAULT 'normal', second_confirmation_status TEXT NOT NULL DEFAULT 'not_required',
  material_status TEXT NOT NULL DEFAULT 'unverified', status TEXT NOT NULL DEFAULT 'open', correction TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]', first_verified_by_account_id TEXT, verified_by_account_id TEXT,
  flow_card_version INTEGER NOT NULL DEFAULT 1, evidence_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, verified_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);
CREATE TABLE IF NOT EXISTS fact_second_confirmations (
  id TEXT PRIMARY KEY, fact_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
  first_verifier_account_id TEXT NOT NULL, confirmer_type TEXT NOT NULL, confirmer_identity TEXT NOT NULL,
  reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (fact_id) REFERENCES candidate_facts(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);

CREATE INDEX IF NOT EXISTS idx_authorizations_project_status ON enterprise_authorizations(project_id, status);
CREATE INDEX IF NOT EXISTS idx_materials_project_visibility ON evidence_materials(project_id, visibility, authorization_status, integrity_status);
CREATE INDEX IF NOT EXISTS idx_candidate_facts_item_status ON candidate_facts(work_item_id, status);
CREATE INDEX IF NOT EXISTS idx_second_confirmations_project ON fact_second_confirmations(project_id, created_at);
