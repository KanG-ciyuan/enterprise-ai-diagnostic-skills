ALTER TABLE evidence_materials ADD COLUMN material_key TEXT NOT NULL DEFAULT '';
ALTER TABLE evidence_materials ADD COLUMN previous_version_id TEXT REFERENCES evidence_materials(id);
ALTER TABLE candidate_facts ADD COLUMN last_transition_key TEXT;

UPDATE evidence_materials SET material_key=id WHERE material_key='';
CREATE UNIQUE INDEX IF NOT EXISTS idx_material_versions_unique ON evidence_materials(project_id, material_key, version);
CREATE INDEX IF NOT EXISTS idx_candidate_transition_key ON candidate_facts(id, last_transition_key);
