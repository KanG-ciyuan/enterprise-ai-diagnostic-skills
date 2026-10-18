import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureSchema } from "../functions/_shared.js";
import { D1Harness } from "./d1_harness.mjs";

const migrations = [
  "0001_core_baseline.sql",
  "0002_evidence_registry.sql",
  "0003_evidence_delivery_upgrade.sql",
  "0004_fact_cas_material_versions.sql",
  "0005_authorization_capability.sql",
  "0006_authorization_notification_outbox.sql",
  "0007_decision_packet_transition_cas.sql",
  "0008_revision_workflow.sql",
  "0009_auth_reassignment_project_gate.sql",
  "0010_member_login_challenges.sql",
  "0011_work_item_assignment_version.sql",
  "0012_builder_account_role.sql",
  "0013_fact_evidence_level.sql",
];

const db = new D1Harness({ loadSchema: false });
for (const migration of migrations) {
  db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
}

const requiredTables = [
  "projects",
  "enterprises",
  "accounts",
  "project_memberships",
  "invitations",
  "sessions",
  "idempotency_records",
  "work_items",
  "events",
  "fact_judgments",
  "evidence_supplements",
  "decision_packets",
  "owner_decisions",
  "enterprise_authorizations",
  "evidence_materials",
  "candidate_facts",
  "fact_second_confirmations",
  "authorization_notification_outbox",
  "member_login_challenges",
];
const actualTables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));
for (const table of requiredTables) assert(actualTables.has(table), `missing table: ${table}`);

const requiredColumns = {
  projects: ["created_by_account_id", "authorization_stage"],
  accounts: ["name", "enterprise_id", "status", "created_at", "account_role"],
  project_memberships: ["scope", "status", "created_at"],
  invitations: ["scope", "status", "accepted_account_id", "idempotency_key", "created_at"],
  sessions: ["project_id", "revoked_at", "created_at"],
  work_items: ["employee_draft_json", "workflow_card_json", "assigned_verifier_id", "assignment_version", "last_submission_key", "supplement_id", "revision_reason", "revision_from_version", "revision_packet_id"],
  events: ["contract_version", "run_id", "member_id", "role", "version", "reason", "source_refs", "authorization", "idempotency_key"],
  evidence_supplements: ["responsible_account_id", "material_id"],
  enterprise_authorizations: ["authorizer_name", "authorizer_email", "creation_idempotency_key", "confirmation_token_nonce", "confirmation_token_expires_at", "confirmation_delivery_status"],
  evidence_materials: ["material_key", "previous_version_id"],
  candidate_facts: ["last_transition_key"],
  decision_packets: ["last_transition_key", "revision_reason", "revision_from_version", "revision_work_item_id"],
  authorization_notification_outbox: ["notification_id", "token_hash", "dispatch_attempts"],
  member_login_challenges: ["account_id", "token_hash", "expires_at", "consumed_at", "consume_claim", "delivery_status", "delivery_error", "created_at"],
};
for (const [table, required] of Object.entries(requiredColumns)) {
  const actual = new Set(db.all(`PRAGMA table_info(${table})`).map((row) => row.name));
  for (const column of required) assert(actual.has(column), `missing column: ${table}.${column}`);
}
const assignmentVersionColumn = db.all("PRAGMA table_info(work_items)").find((row) => row.name === "assignment_version");
assert.equal(Number(assignmentVersionColumn.notnull), 1);
assert.equal(String(assignmentVersionColumn.dflt_value), "1");

const requiredIndexes = [
  "idx_work_items_project_stage",
  "idx_events_project_created",
  "idx_decision_packets_project_version",
  "idx_authorizations_project_status",
  "idx_materials_project_visibility",
  "idx_candidate_facts_item_status",
  "idx_second_confirmations_project",
  "idx_material_versions_unique",
  "idx_candidate_transition_key",
  "idx_authorization_creation_idempotency",
  "idx_authorization_outbox_status",
  "idx_decision_packet_transition_key",
  "idx_revision_task_packet",
  "idx_member_login_challenges_account_created",
  "idx_member_login_challenges_expiry",
];
const actualIndexes = new Set(db.all("SELECT name FROM sqlite_master WHERE type='index'").map((row) => row.name));
for (const index of requiredIndexes) assert(actualIndexes.has(index), `missing index: ${index}`);

function foreignKeyMappings(database) {
  return requiredTables.flatMap((table) => database.all(`PRAGMA foreign_key_list(${table})`).map((row) => `${table}.${row.from}->${row.table}.${row.to}`)).sort();
}

const requiredForeignKeys = [
  "authorization_notification_outbox.authorization_id->enterprise_authorizations.id",
  "member_login_challenges.account_id->accounts.id",
  "candidate_facts.project_id->projects.id",
  "candidate_facts.work_item_id->work_items.id",
  "decision_packets.project_id->projects.id",
  "enterprise_authorizations.project_id->projects.id",
  "events.project_id->projects.id",
  "evidence_materials.authorization_record_id->enterprise_authorizations.id",
  "evidence_materials.previous_version_id->evidence_materials.id",
  "evidence_materials.project_id->projects.id",
  "fact_second_confirmations.fact_id->candidate_facts.id",
  "fact_second_confirmations.project_id->projects.id",
  "fact_second_confirmations.work_item_id->work_items.id",
  "owner_decisions.packet_id->decision_packets.id",
  "owner_decisions.project_id->projects.id",
  "work_items.project_id->projects.id",
].sort();
const migratedForeignKeys = foreignKeyMappings(db);
assert.deepEqual(migratedForeignKeys, requiredForeignKeys, "numbered migrations have incorrect foreign keys");
assert.deepEqual(db.all("PRAGMA foreign_key_check"), [], "numbered migrations violate a foreign key");

const schemaDb = new D1Harness();
const schemaForeignKeys = foreignKeyMappings(schemaDb);
assert.deepEqual(schemaForeignKeys, requiredForeignKeys, "schema.sql has unexpected foreign keys");
assert.deepEqual(migratedForeignKeys, schemaForeignKeys, "numbered migrations and schema.sql have different foreign keys");
schemaDb.close();

const snapshotSql = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name";
const beforeEnsureSchema = db.all(snapshotSql);
const binding = { prepare: (...args) => db.prepare(...args), batch: (...args) => db.batch(...args) };
await ensureSchema(binding);
assert.deepEqual(db.all(snapshotSql), beforeEnsureSchema, "ensureSchema changed the fully migrated schema");

db.close();
console.log("raw migration chain and runtime schema compatibility: ok");
