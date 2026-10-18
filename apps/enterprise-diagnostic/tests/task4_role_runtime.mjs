import assert from "node:assert/strict";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";
import { onRequestGet as verifierFacts } from "../functions/api/formal/projects/[projectId]/verifier-facts.js";
import { onRequestGet as confirmedFacts } from "../functions/api/formal/projects/[projectId]/confirmed-facts.js";
import { onRequestPost as createDecisionDraft } from "../functions/api/formal/projects/[projectId]/decision-packets/draft.js";
import { onRequestPost as verifyFact } from "../functions/api/work-items/[itemId]/verification.js";
import { onRequestPost as provideEvidence } from "../functions/api/work-items/[itemId]/evidence-supplement.js";
import { onRequestGet as employeeTask } from "../functions/api/projects/[projectId]/employee-task.js";
import { onRequest as listWorkItems } from "../functions/api/projects/[projectId]/work-items.js";
import { onRequestGet as listMaterials, onRequestPost as createMaterial } from "../functions/api/projects/[projectId]/materials.js";
import { onRequestPost as reviewMaterial } from "../functions/api/projects/[projectId]/materials/[materialId]/review.js";
import { onRequestPost as createProject } from "../functions/api/projects.js";
import { onRequestPost as createInvitation } from "../functions/api/projects/[projectId]/invitations.js";
import { onRequestPost as revokeInvitation } from "../functions/api/invitations/[invitationRef]/revoke.js";
import { onRequestPost as acceptInvitation } from "../functions/api/invitations/[invitationRef]/accept.js";
import { onRequest as projectDetail } from "../functions/api/projects/[projectId].js";

async function call(handler, path, token, params, body, headers = {}) {
  const response = await handler({
    request: bearerRequest(`http://127.0.0.1${path}`, token, body, headers),
    env: { DB: db },
    params,
  });
  return { status: response.status, body: JSON.parse(await response.text()) };
}

const db = new D1Harness();
db.exec(`
  INSERT INTO enterprises(id,name) VALUES ('ENT-T4','Task4 Enterprise');
  INSERT INTO accounts(id,email,name,enterprise_id,status) VALUES
    ('BLD-T4','builder@example.invalid','Builder','ENT-T4','active'),
    ('EMP-T4','employee@example.invalid','Employee','ENT-T4','active'),
    ('VER1-T4','verifier1@example.invalid','Verifier One','ENT-T4','active'),
    ('VER2-T4','verifier2@example.invalid','Verifier Two','ENT-T4','active'),
    ('OWN-T4','owner@example.invalid','Owner','ENT-T4','active');
  INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id)
    VALUES ('PRJ-T4','Role runtime','Sales handoff','facts','active','L2','external_builder','BLD-T4');
  INSERT INTO project_memberships(project_id,account_id,role,status) VALUES
    ('PRJ-T4','BLD-T4','external_builder','active'),
    ('PRJ-T4','EMP-T4','employee','active'),
    ('PRJ-T4','VER1-T4','verifier','active'),
    ('PRJ-T4','VER2-T4','verifier','active'),
    ('PRJ-T4','OWN-T4','owner','active');
  INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
    ('TOK-BLD-T4','BLD-T4','PRJ-T4','2099-01-01T00:00:00Z','REF-BLD-T4'),
    ('TOK-EMP-T4','EMP-T4','PRJ-T4','2099-01-01T00:00:00Z','REF-EMP-T4'),
    ('TOK-VER1-T4','VER1-T4','PRJ-T4','2099-01-01T00:00:00Z','REF-VER1-T4'),
    ('TOK-VER2-T4','VER2-T4','PRJ-T4','2099-01-01T00:00:00Z','REF-VER2-T4'),
    ('TOK-OWN-T4','OWN-T4','PRJ-T4','2099-01-01T00:00:00Z','REF-OWN-T4');
  INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,source_employee_account_id,assigned_verifier_id,judgment_status,submission_version,submitted_at,handoff_status)
    VALUES ('WI-T4','PRJ-T4','Customer handoff','Employee described flow','facts','awaiting_verification','verifier','Verifier One',80,'','verify','VER1-T4','EMP-T4','VER1-T4','open',1,'2026-08-25T01:00:00Z','assigned');
  INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
    VALUES ('AUTH-T4','PRJ-T4','OA export','Named Owner','owner@example.invalid','read','oa-auth','authorized','BLD-T4','auth-t4','nonce','hash','2099-01-01T00:00:00Z');
  INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference)
    VALUES ('MAT-T4','PRJ-T4','MKEY-T4',3,'pdf','AUTH-T4','authorized','verified','verifier','BLD-T4','WI-T4','OA export','oa://export/3');
  INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json)
    VALUES ('FACT-T4','PRJ-T4','WI-T4','execution','Approval completed before CRM handoff','steps',1,'high','not_required','unverified','open','[]');
  INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,status,expires_at)
    VALUES ('INV-T4','invite-t4','PRJ-T4','BLD-T4','new@example.invalid','employee','pending','2099-01-01T00:00:00Z');
  INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) VALUES
    ('EVT-OLD','PRJ-T4','WI-T4','employee_submission','employee','EMP-T4','{}'),
    ('EVT-NEW','PRJ-T4','WI-T4','handoff','verifier','VER1-T4','{}');
`);

const registered = await call(createMaterial, "/api/projects/PRJ-T4/materials", "TOK-BLD-T4", { projectId: "PRJ-T4" }, { authorizationRecordId: "AUTH-T4", workItemId: "WI-T4", label: "CRM export", reference: "crm://export/4", sourceType: "csv", visibility: "verifier", metadata: { batch: "4" } });
assert.equal(registered.status, 201, JSON.stringify(registered.body));
assert.equal(registered.body.material.integrity_status, "pending");
const reviewedMaterial = await call(reviewMaterial, `/api/projects/PRJ-T4/materials/${registered.body.material.id}/review`, "TOK-VER1-T4", { projectId: "PRJ-T4", materialId: registered.body.material.id }, { decision: "verified", reason: "Hash matched source export" });
assert.equal(reviewedMaterial.status, 200, JSON.stringify(reviewedMaterial.body));
assert.equal(reviewedMaterial.body.material.integrity_status, "verified");

const queue = await call(verifierFacts, "/api/formal/projects/PRJ-T4/verifier-facts", "TOK-VER1-T4", { projectId: "PRJ-T4" });
assert.equal(queue.status, 200);
const stableMaterial = queue.body.facts[0].eligibleMaterials.find((entry) => entry.materialId === "MAT-T4");
assert.equal(stableMaterial.materialKey, "MKEY-T4");
assert.equal(stableMaterial.version, 3);
assert.ok(queue.body.facts[0].eligibleMaterials.some((entry) => entry.materialId === registered.body.material.id && entry.integrityStatus === "verified"));

const first = await call(verifyFact, "/api/work-items/WI-T4/verification", "TOK-VER1-T4", { itemId: "WI-T4" }, {
  factId: "FACT-T4", decision: "same", reason: "Matched OA export v3", sourceRefs: ["MAT-T4"],
});
assert.equal(first.status, 200, JSON.stringify(first.body));
assert.equal(db.get("SELECT status FROM candidate_facts WHERE id='FACT-T4'").status, "awaiting_second_confirmation");

const firstVerifierAfterHighImpact = await call(verifierFacts, "/api/formal/projects/PRJ-T4/verifier-facts", "TOK-VER1-T4", { projectId: "PRJ-T4" });
assert.equal(firstVerifierAfterHighImpact.status, 200);
assert.ok(!firstVerifierAfterHighImpact.body.facts.some((entry) => entry.factId === "FACT-T4"), "first verifier must not receive their own independent second-confirmation task");

const secondQueue = await call(verifierFacts, "/api/formal/projects/PRJ-T4/verifier-facts", "TOK-VER2-T4", { projectId: "PRJ-T4" });
assert.equal(secondQueue.status, 200);
assert.equal(secondQueue.body.facts[0].factId, "FACT-T4");
assert.equal(secondQueue.body.facts[0].secondConfirmationAction, "second_confirmation");
assert.deepEqual(secondQueue.body.progress, { current: 1, total: 1, completed: 0 });

const second = await call(verifyFact, "/api/work-items/WI-T4/verification", "TOK-VER2-T4", { itemId: "WI-T4" }, {
  factId: "FACT-T4", action: "second_confirmation", secondConfirmationReason: "Independent review matched material v3",
});
assert.equal(second.status, 200, JSON.stringify(second.body));
assert.equal(db.get("SELECT status FROM candidate_facts WHERE id='FACT-T4'").status, "confirmed");
const completedSecondQueue = await call(verifierFacts, "/api/formal/projects/PRJ-T4/verifier-facts", "TOK-VER2-T4", { projectId: "PRJ-T4" });
assert.deepEqual(completedSecondQueue.body.progress, { current: 1, total: 1, completed: 1 });
const builderConfirmed = await call(confirmedFacts, "/api/formal/projects/PRJ-T4/confirmed-facts", "TOK-BLD-T4", { projectId: "PRJ-T4" });
assert.equal(builderConfirmed.status, 200);
assert.ok(builderConfirmed.body.facts.some((entry) => entry.factId === "FACT-T4"), "builder must receive a confirmed fact backed by a verifier-scoped material without receiving the raw material body");
const draft = await call(createDecisionDraft, "/api/formal/projects/PRJ-T4/decision-packets/draft", "TOK-BLD-T4", { projectId: "PRJ-T4" }, {
  factRefs: [{ factId: "FACT-T4" }], riskSummary: "Invisible wait", pilotScope: "Five day shadow", constraints: ["read only"], successMetrics: ["wait reduced"], stopConditions: ["error rises"], downstreamOwner: "Operations",
}, { "Idempotency-Key": "draft-verifier-material" });
assert.equal(draft.status, 201, JSON.stringify(draft.body));

db.exec(`
  UPDATE work_items SET stage='facts',status='blocked',judgment_status='blocked',supplement_id='SUP-T4',evidence_version=1 WHERE id='WI-T4';
  UPDATE candidate_facts SET status='insufficient_evidence',material_status='insufficient_evidence',evidence_version=1 WHERE id='FACT-T4';
  INSERT INTO evidence_supplements(id,work_item_id,fact_id,requested_material,responsible_person,responsible_account_id,deadline,recovery_entry,authorization_scope,source_refs,old_evidence_version,new_evidence_version,status)
    VALUES ('SUP-T4','WI-T4','FACT-T4','New OA export','Employee','EMP-T4','2099-01-01T00:00:00Z','Recheck FACT-T4','project','[]',1,2,'waiting');
`);
const supplemented = await call(provideEvidence, "/api/work-items/WI-T4/evidence-supplement", "TOK-EMP-T4", { itemId: "WI-T4" }, {
  material: "Authorized OA export", reference: "oa://export/4", sourceType: "pdf", metadata: { approvalId: "OA-4" },
});
assert.equal(supplemented.status, 200, JSON.stringify(supplemented.body));
assert.equal(supplemented.body.item.status, "awaiting_verification");
const supplementMetadata = JSON.parse(db.get("SELECT metadata_json FROM evidence_materials WHERE id=?", supplemented.body.recovery.materialId).metadata_json);
assert.equal(supplementMetadata.approvalId, "OA-4");

for (const [token, expected] of [["TOK-OWN-T4", 403], ["TOK-EMP-T4", 200], ["TOK-VER1-T4", 200], ["TOK-BLD-T4", 200]]) {
  const materials = await call(listMaterials, "/api/projects/PRJ-T4/materials", token, { projectId: "PRJ-T4" });
  assert.equal(materials.status, expected, `${token} materials status`);
  if (token === "TOK-EMP-T4" && materials.status === 200) assert.ok(materials.body.materials.every((entry) => entry.work_item_id === "WI-T4"));
  if (token === "TOK-BLD-T4" && materials.status === 200) assert.ok(materials.body.materials.some((entry) => entry.id === registered.body.material.id), "builder must retain control-plane visibility of a verifier-scoped material it registered");
}
const ownerItems = await call(listWorkItems, "/api/projects/PRJ-T4/work-items", "TOK-OWN-T4", { projectId: "PRJ-T4" });
assert.equal(ownerItems.status, 403);

const employeeCreate = await call(createProject, "/api/projects", "TOK-EMP-T4", {}, { name: "Escalated", scope: "Forbidden" });
assert.equal(employeeCreate.status, 403);
const verifierCreate = await call(createProject, "/api/projects", "TOK-VER1-T4", {}, { name: "Escalated", scope: "Forbidden" });
assert.equal(verifierCreate.status, 403);
const ownerCreate = await call(createProject, "/api/projects", "TOK-OWN-T4", {}, { name: "Escalated", scope: "Forbidden" });
assert.equal(ownerCreate.status, 403);

const ownerInvite = await call(createInvitation, "/api/projects/PRJ-T4/invitations", "TOK-OWN-T4", { projectId: "PRJ-T4" }, { email: "other@example.invalid", role: "employee" });
assert.equal(ownerInvite.status, 403);
const ownerRevoke = await call(revokeInvitation, "/api/invitations/INV-T4/revoke", "TOK-OWN-T4", { invitationRef: "INV-T4" }, {});
assert.equal(ownerRevoke.status, 403);

const detail = await call(projectDetail, "/api/projects/PRJ-T4", "TOK-BLD-T4", { projectId: "PRJ-T4" });
assert.equal(detail.status, 200);
assert.ok(detail.body.tasks.some((item) => item.id === "WI-T4"), "builder control must include the current employee/verifier task");
assert.equal(detail.body.latestEvent.type, "evidence_provided");

db.exec(`
  INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload,created_at) VALUES
    ('AAA-CHRONOLOGICALLY-LATEST','PRJ-T4','WI-T4','newest_event','verifier','VER1-T4','{}','2099-01-01T00:00:00Z'),
    ('ZZZ-INSERTED-LATEST','PRJ-T4','WI-T4','older_event','verifier','VER1-T4','{}','2020-01-01T00:00:00Z');
`);
const detailByTime = await call(projectDetail, "/api/projects/PRJ-T4", "TOK-BLD-T4", { projectId: "PRJ-T4" });
assert.equal(detailByTime.body.latestEvent.type, "newest_event");

db.exec("UPDATE work_items SET stage='decision',status='awaiting_decision',assignee_role='owner',assignee_account_id=NULL WHERE id='WI-T4'");
const employeeFinal = await call(employeeTask, "/api/projects/PRJ-T4/employee-task", "TOK-EMP-T4", { projectId: "PRJ-T4" });
assert.equal(employeeFinal.status, 200);
assert.equal(employeeFinal.body.task.status, "awaiting_decision");

db.exec(`
  INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,status,expires_at)
    VALUES ('INV-SWITCH','invite-switch','PRJ-T4','BLD-T4','switch-owner@example.invalid','owner','pending','2099-01-01T00:00:00Z');
`);
const switched = await call(acceptInvitation, "/api/invitations/invite-switch/accept", "TOK-BLD-T4", { invitationRef: "invite-switch" }, { email: "switch-owner@example.invalid", name: "Switch Owner" });
assert.equal(switched.status, 200, JSON.stringify(switched.body));
assert.equal(switched.body.role, "owner");
assert.ok(db.get("SELECT revoked_at FROM sessions WHERE token='TOK-BLD-T4'").revoked_at, "accepting a new invite must revoke the current old-role session");

db.close();
console.log("task4 role workbench runtime: ok");
