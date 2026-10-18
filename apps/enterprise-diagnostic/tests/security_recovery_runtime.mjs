import assert from "node:assert/strict";
import { onRequestPost as authorize } from "../functions/api/auth/authorize.js";
import { onRequestPost as createProject } from "../functions/api/projects.js";
import { onRequestPost as provideSupplement } from "../functions/api/work-items/[itemId]/evidence-supplement.js";
import { onRequestPost as bindAuthorization } from "../functions/api/projects/[projectId]/materials/[materialId]/authorization-binding.js";
import { onRequestPost as reviewMaterial } from "../functions/api/projects/[projectId]/materials/[materialId]/review.js";
import { onRequestPost as verifyFact } from "../functions/api/work-items/[itemId]/verification.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

async function read(handler, request, params, env) {
  const response = await handler({ request, params, env });
  return { status: response.status, body: JSON.parse(await response.text()) };
}

const authDb = new D1Harness();
authDb.exec(`
  INSERT INTO enterprises(id,name) VALUES ('ENT-SEC','Security Test');
  INSERT INTO accounts(id,email,name,enterprise_id,status,account_role) VALUES ('OWN-SEC','owner@example.invalid','Owner','ENT-SEC','active','external_builder');
  INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES ('PRJ-SEC','Existing','Scope','scope','active','unknown','external_builder','OWN-SEC');
  INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('PRJ-SEC','OWN-SEC','owner','active');
`);
// D-3：运行模式改为白名单判定，测试必须显式声明 development；
// 未声明模式按生产语义处理（安全拒绝），因此这里显式给出。
const authEnv = { DB: authDb, FORMAL_AUTH_MODE: "development", FORMAL_AUTH_TEST_MODE: "1" };
// The bootstrap token is now actually verified. Previously TEST_MODE=1 skipped the
// token check entirely, so any string was accepted and this test never reached its
// own subject (the email-hijack guard). Use the development test code so the two
// assertions below genuinely exercise that guard.
const hijack = await read(authorize, new Request("http://127.0.0.1/api/auth/authorize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.invalid", enterpriseName: "Security Test", bootstrapToken: "123456" }) }), {}, authEnv);
assert.equal(hijack.status, 409, "bootstrap must not turn an existing member email into a new session");
assert.equal(hijack.body.code, "account_exists");

authDb.exec("INSERT INTO sessions(token,account_id,expires_at,refresh_token) VALUES ('TOK-SEC','OWN-SEC','2099-01-01T00:00:00Z','REF-SEC')");
const createRequest = () => bearerRequest("http://127.0.0.1/api/projects", "TOK-SEC", { name: "Idempotent project", scope: "Sales handoff" }, { "Idempotency-Key": "PROJECT-ONE" });
const created = await read(createProject, createRequest(), {}, authEnv);
assert.equal(created.status, 201);
const replay = await read(createProject, createRequest(), {}, authEnv);
assert.equal(replay.status, 201);
assert.deepEqual(replay.body, created.body);
assert.equal(authDb.count("projects"), 2);
assert.equal(authDb.count("idempotency_records"), 1);
const conflicting = await read(createProject, bearerRequest("http://127.0.0.1/api/projects", "TOK-SEC", { name: "Different", scope: "Different" }, { "Idempotency-Key": "PROJECT-ONE" }), {}, authEnv);
assert.equal(conflicting.status, 409);
authDb.close();

const db = new D1Harness();
db.exec(`
  INSERT INTO enterprises(id,name) VALUES ('ENT-REC','Recovery Test');
  INSERT INTO accounts(id,email,name,enterprise_id,status) VALUES
    ('BLD-REC','builder@recovery.invalid','Builder','ENT-REC','active'),
    ('EMP-REC','employee@recovery.invalid','Employee','ENT-REC','active'),
    ('VER-REC','verifier@recovery.invalid','Verifier','ENT-REC','active');
  INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES ('PRJ-REC','Recovery','Sales handoff','facts','active','L2','external_builder','BLD-REC');
  INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('PRJ-REC','BLD-REC','external_builder','active'),('PRJ-REC','EMP-REC','employee','active'),('PRJ-REC','VER-REC','verifier','active');
  INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-BLD-REC','BLD-REC','PRJ-REC','2099-01-01T00:00:00Z','REF-BLD-REC'),('TOK-EMP-REC','EMP-REC','PRJ-REC','2099-01-01T00:00:00Z','REF-EMP-REC'),('TOK-VER-REC','VER-REC','PRJ-REC','2099-01-01T00:00:00Z','REF-VER-REC');
  INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,evidence_version,assigned_verifier_id,judgment_status,supplement_id) VALUES ('WI-REC','PRJ-REC','Customer handoff','Flow','facts','blocked','employee','Employee',40,'Evidence needed','Provide evidence',2,'VER-REC','blocked','SUP-REC');
  INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,evidence_version,assigned_verifier_id,judgment_status) VALUES ('WI-ROLE','PRJ-REC','Role policy','Flow','facts','awaiting_verification','verifier','Verifier',40,'','Verify',1,'VER-REC','open');
  INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,material_status,status,evidence_version) VALUES ('FACT-REC','PRJ-REC','WI-REC','execution','Approval completed','steps','insufficient_evidence','insufficient_evidence',2);
  INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,material_status,status,evidence_version) VALUES ('FACT-ROLE','PRJ-REC','WI-ROLE','execution','Role policy fact','steps','unverified','open',1);
  INSERT INTO evidence_supplements(id,work_item_id,fact_id,requested_material,responsible_person,responsible_account_id,deadline,recovery_entry,authorization_scope,source_refs,old_evidence_version,new_evidence_version,status) VALUES ('SUP-REC','WI-REC','FACT-REC','OA export','Employee','EMP-REC','2099-01-01T00:00:00Z','Recheck FACT-REC','project','[]',2,3,'waiting');
  INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES ('AUTH-REC','PRJ-REC','OA','Named Owner','owner@recovery.invalid','read','oa://auth','authorized','BLD-REC','AUTH-REC-KEY','nonce','hash','2099-01-01T00:00:00Z');
`);
const env = { DB: db };
const builderCannotBeResponsible = await read(verifyFact, bearerRequest("http://127.0.0.1/api/work-items/WI-ROLE/verification", "TOK-VER-REC", { factId: "FACT-ROLE", decision: "insufficient_evidence", reason: "Need data", requestedMaterial: "OA export", responsibleAccountId: "BLD-REC" }), { itemId: "WI-ROLE" }, env);
assert.equal(builderCannotBeResponsible.status, 422);
assert.equal(db.get("SELECT status FROM candidate_facts WHERE id='FACT-ROLE'").status, "open");
const supplementRequest = bearerRequest("http://127.0.0.1/api/work-items/WI-REC/evidence-supplement", "TOK-EMP-REC", { material: "OA export", reference: "oa://export/recovery", sourceType: "pdf" });
const supplemented = await read(provideSupplement, supplementRequest, { itemId: "WI-REC" }, env);
assert.equal(supplemented.status, 200);
const materialId = supplemented.body.recovery.materialId;
assert.equal(db.get("SELECT authorization_record_id,authorization_status FROM evidence_materials WHERE id=?", materialId).authorization_record_id, null);

const bindRequest = () => bearerRequest(`http://127.0.0.1/api/projects/PRJ-REC/materials/${materialId}/authorization-binding`, "TOK-BLD-REC", { authorizationRecordId: "AUTH-REC" }, { "Idempotency-Key": "BIND-REC" });
const [bound, boundReplay] = await Promise.all([
  read(bindAuthorization, bindRequest(), { projectId: "PRJ-REC", materialId }, env),
  read(bindAuthorization, bindRequest(), { projectId: "PRJ-REC", materialId }, env),
]);
assert.equal(bound.status, 200);
assert.equal(bound.body.material.authorizationStatus, "authorized");
assert.equal(boundReplay.status, 200);
assert.deepEqual(boundReplay.body, bound.body);
assert.equal(db.count("events"), 2, "supplement and binding each write one event");

const reviewed = await read(reviewMaterial, bearerRequest(`http://127.0.0.1/api/projects/PRJ-REC/materials/${materialId}/review`, "TOK-VER-REC", { decision: "verified", reason: "Matched named export" }), { projectId: "PRJ-REC", materialId }, env);
assert.equal(reviewed.status, 200);
const confirmed = await read(verifyFact, bearerRequest("http://127.0.0.1/api/work-items/WI-REC/verification", "TOK-VER-REC", { factId: "FACT-REC", decision: "same", reason: "Matched authorized export", sourceRefs: [materialId] }), { itemId: "WI-REC" }, env);
assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
assert.equal(db.get("SELECT status FROM candidate_facts WHERE id='FACT-REC'").status, "confirmed");
db.close();
console.log("security and recoverable evidence runtime: ok");
