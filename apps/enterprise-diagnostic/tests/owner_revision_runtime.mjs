import assert from "node:assert/strict";
import { onRequestPost as decidePacket } from "../functions/api/formal/decision-packets/[packetId]/owner-decision.js";
import { onRequestPost as draftPacket } from "../functions/api/formal/projects/[projectId]/decision-packets/draft.js";
import { onRequestPost as verifyPacket } from "../functions/api/formal/decision-packets/[packetId]/verify.js";
import { onRequestPost as publishPacket } from "../functions/api/formal/decision-packets/[packetId]/publish.js";
import { onRequest as listWorkItems } from "../functions/api/projects/[projectId]/work-items.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const db = new D1Harness();
db.exec(`
  INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES ('PRJ-R','Revision flow','Customer handoff','decision','active','L2','external_builder','BLD-R');
  INSERT INTO accounts(id,email,name,status) VALUES ('BLD-R','builder@example.invalid','External Builder','active'),('VER-R','verifier@example.invalid','Named Verifier','active'),('OWN-R','owner@example.invalid','Enterprise Owner','active'),('EMP-R','employee@example.invalid','Employee','active');
  INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES ('AUTH-R','PRJ-R','Test authorization','Owner','owner@example.invalid','synthetic','test://authorization','authorized','BLD-R','AUTH-R-KEY','nonce','hash','2099-01-01T00:00:00Z');
  INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('PRJ-R','BLD-R','external_builder','active'),('PRJ-R','VER-R','verifier','active'),('PRJ-R','OWN-R','owner','active'),('PRJ-R','EMP-R','employee','active');
  INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-BLD-R','BLD-R','PRJ-R','2099-01-01T00:00:00Z','REF-BLD-R'),('TOK-VER-R','VER-R','PRJ-R','2099-01-01T00:00:00Z','REF-VER-R'),('TOK-OWN-R','OWN-R','PRJ-R','2099-01-01T00:00:00Z','REF-OWN-R');
  INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,judgment_status,source_employee_account_id) VALUES ('WI-R','PRJ-R','Employee flow','Confirmed flow','decision','awaiting_decision','owner','Enterprise Owner',100,'等待负责人决策','await decision','confirmed','EMP-R');
  INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference) VALUES ('MAT-R','PRJ-R','MAT-STABLE-R',3,'oa_export','authorized','verified','project','BLD-R','WI-R','OA export','oa://approved/3');
  INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,material_status,status,source_refs_json) VALUES ('FACT-R','PRJ-R','WI-R','execution','Approved fact','steps','same','confirmed','["MAT-R"]');
  INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,verifier_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,verified_at,published_at) VALUES ('PKT-R1','PRJ-R',1,'published','BLD-R','VER-R','[{"factId":"FACT-R","sourceRefs":["MAT-R"]}]','Risk v1','Pilot v1','["read only"]','["lead time"]','["error rises"]','Pilot owner','2026-08-25T01:00:00Z','2026-08-25T02:00:00Z');
`);

async function invoke(handler, path, token, params, body, headers = {}) {
  const response = await handler({ request: bearerRequest(`http://127.0.0.1${path}`, token, body, headers), env: { DB: db }, params });
  return { status: response.status, body: JSON.parse(await response.text()) };
}

const revisionBody = { decision: "revision", reason: "试点范围过大，请缩小到华东销售组。", scope: "华东销售组", constraints: ["只读"], successMetrics: ["等待时长下降"], stopConditions: ["错误率上升"], downstreamOwner: "Pilot owner" };
const revised = await invoke(decidePacket, "/api/formal/decision-packets/PKT-R1/owner-decision", "TOK-OWN-R", { packetId: "PKT-R1" }, revisionBody, { "Idempotency-Key": "owner-revision-r1" });
assert.equal(revised.status, 200, JSON.stringify(revised.body));
assert.equal(revised.body.receipt.decision, "revision");
assert.equal(revised.body.receipt.packetVersion, 1);
assert.equal(revised.body.receipt.revisionReason, revisionBody.reason);
assert.equal(revised.body.receipt.downstreamOwner, "External Builder");
assert.equal(db.get("SELECT status FROM decision_packets WHERE id='PKT-R1'").status, "revision_requested");
assert.equal(db.get("SELECT status FROM work_items WHERE id='WI-R'").status, "awaiting_decision");

const revisionTask = db.get("SELECT * FROM work_items WHERE project_id='PRJ-R' AND assignee_role='external_builder'");
assert.ok(revisionTask, "revision must create one builder task");
assert.equal(revisionTask.status, "revision_requested");
assert.equal(revisionTask.assignee_account_id, "BLD-R");
assert.equal(revisionTask.revision_reason, revisionBody.reason);
assert.equal(revisionTask.revision_from_version, 1);

const builderQueue = await invoke(listWorkItems, "/api/projects/PRJ-R/work-items", "TOK-BLD-R", { projectId: "PRJ-R" }, undefined);
assert.equal(builderQueue.status, 200);
assert.equal(builderQueue.body.items.length, 1);
assert.equal(builderQueue.body.items[0].revisionReason, revisionBody.reason);
assert.equal(builderQueue.body.items[0].revisionFromVersion, 1);

const replay = await invoke(decidePacket, "/api/formal/decision-packets/PKT-R1/owner-decision", "TOK-OWN-R", { packetId: "PKT-R1" }, revisionBody, { "Idempotency-Key": "owner-revision-r1" });
assert.equal(replay.status, 200);
assert.deepEqual(replay.body, revised.body);
assert.equal(Number(db.get("SELECT COUNT(*) AS count FROM owner_decisions WHERE packet_id='PKT-R1'").count), 1);
assert.equal(Number(db.get("SELECT COUNT(*) AS count FROM work_items WHERE revision_packet_id='PKT-R1'").count), 1);

const draftBody = { factRefs: [{ factId: "FACT-R" }], riskSummary: "Risk v2", pilotScope: "华东销售组", constraints: ["只读"], successMetrics: ["等待时长下降"], stopConditions: ["错误率上升"], downstreamOwner: "Pilot owner" };
const [v2, v2Replay] = await Promise.all([
  invoke(draftPacket, "/api/formal/projects/PRJ-R/decision-packets/draft", "TOK-BLD-R", { projectId: "PRJ-R" }, draftBody, { "Idempotency-Key": "draft-r2" }),
  invoke(draftPacket, "/api/formal/projects/PRJ-R/decision-packets/draft", "TOK-BLD-R", { projectId: "PRJ-R" }, draftBody, { "Idempotency-Key": "draft-r2" }),
]);
assert.equal(v2.status, 201, JSON.stringify(v2.body));
assert.equal(v2Replay.status, 201, JSON.stringify(v2Replay.body));
assert.deepEqual(v2Replay.body, v2.body);
assert.equal(v2.body.packet.version, 2);
assert.equal(v2.body.packet.status, "draft");
assert.equal(v2.body.packet.revisionFromVersion, 1);
assert.equal(v2.body.packet.revisionReason, revisionBody.reason);
assert.equal(v2.body.packet.verifierAccountId, null);
assert.equal(v2.body.packet.verifiedAt, null);
assert.equal(db.get("SELECT status FROM work_items WHERE id=?", revisionTask.id).status, "awaiting_verification");
assert.equal(Number(db.get("SELECT COUNT(*) AS count FROM decision_packets WHERE project_id='PRJ-R' AND version=2").count), 1);
assert.equal(Number(db.get("SELECT COUNT(*) AS count FROM idempotency_records WHERE project_id='PRJ-R' AND action='decision-packet-draft' AND request_key='draft-r2'").count), 1);

const premature = await invoke(publishPacket, `/api/formal/decision-packets/${v2.body.packet.id}/publish`, "TOK-BLD-R", { packetId: v2.body.packet.id }, {});
assert.equal(premature.status, 409);
const verified = await invoke(verifyPacket, `/api/formal/decision-packets/${v2.body.packet.id}/verify`, "TOK-VER-R", { packetId: v2.body.packet.id }, { factRefs: v2.body.packet.factRefs });
assert.equal(verified.status, 200, JSON.stringify(verified.body));
assert.equal(verified.body.packet.status, "verifier_checked");
const published = await invoke(publishPacket, `/api/formal/decision-packets/${v2.body.packet.id}/publish`, "TOK-BLD-R", { packetId: v2.body.packet.id }, {});
assert.equal(published.status, 200, JSON.stringify(published.body));
assert.equal(published.body.packet.status, "published");
assert.equal(db.get("SELECT status FROM work_items WHERE id=?", revisionTask.id).status, "complete");
assert.equal(db.get("SELECT status FROM work_items WHERE id='WI-R'").status, "awaiting_decision");
const finalDecisionBody = { ...revisionBody, decision: "continue", reason: "批准华东销售组影子试点。" };
const finalDecision = await invoke(decidePacket, `/api/formal/decision-packets/${v2.body.packet.id}/owner-decision`, "TOK-OWN-R", { packetId: v2.body.packet.id }, finalDecisionBody, { "Idempotency-Key": "owner-final-r2" });
assert.equal(finalDecision.status, 200, JSON.stringify(finalDecision.body));
assert.equal(db.get("SELECT status FROM work_items WHERE id='WI-R'").status, "complete");
assert.match(db.get("SELECT next_action FROM work_items WHERE id='WI-R'").next_action, /同意进入影子试点/);

const dbAtomic = new D1Harness();
dbAtomic.exec(`
  INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES ('PRJ-A','Atomic','Scope','decision','active','L2','external_builder','BLD-A');
  INSERT INTO accounts(id,email,name,status) VALUES ('BLD-A','ba@example.invalid','Builder A','active'),('OWN-A','oa@example.invalid','Owner A','active');
  INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES ('AUTH-A','PRJ-A','Test authorization','Owner A','oa@example.invalid','synthetic','test://authorization','authorized','BLD-A','AUTH-A-KEY','nonce','hash','2099-01-01T00:00:00Z');
  INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('PRJ-A','BLD-A','external_builder','active'),('PRJ-A','OWN-A','owner','active');
  INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-OWN-A','OWN-A','PRJ-A','2099-01-01T00:00:00Z','REF-OWN-A');
  INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,published_at) VALUES ('PKT-A','PRJ-A',1,'published','BLD-A','[]','Risk','Pilot','["c"]','["m"]','["s"]','Owner','2026-08-25T02:00:00Z');
`);
dbAtomic.failOnEvent = true;
const failed = await decidePacket({ request: bearerRequest("http://127.0.0.1/api/formal/decision-packets/PKT-A/owner-decision", "TOK-OWN-A", revisionBody, { "Idempotency-Key": "atomic-r1" }), env: { DB: dbAtomic }, params: { packetId: "PKT-A" } });
assert.equal(failed.status, 500);
assert.equal(dbAtomic.get("SELECT status FROM decision_packets WHERE id='PKT-A'").status, "published");
assert.equal(Number(dbAtomic.get("SELECT COUNT(*) AS count FROM owner_decisions").count), 0);
assert.equal(Number(dbAtomic.get("SELECT COUNT(*) AS count FROM work_items").count), 0);

dbAtomic.close();

const dbRace = new D1Harness();
dbRace.exec(`
  INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES ('PRJ-C','Competing drafts','Scope','decision','active','L2','external_builder','BLD-C');
  INSERT INTO accounts(id,email,name,status) VALUES ('BLD-C','bc@example.invalid','Builder C','active');
  INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES ('AUTH-C','PRJ-C','Test authorization','Owner C','owner-c@example.invalid','synthetic','test://authorization','authorized','BLD-C','AUTH-C-KEY','nonce','hash','2099-01-01T00:00:00Z');
  INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('PRJ-C','BLD-C','external_builder','active');
  INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-BLD-C','BLD-C','PRJ-C','2099-01-01T00:00:00Z','REF-BLD-C');
  INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,judgment_status,revision_reason,revision_from_version,revision_packet_id) VALUES ('REV-C','PRJ-C','Revise','Reason','decision','revision_requested','external_builder','Builder C',100,'Reason','Draft v2','BLD-C','confirmed','Reason',1,'PKT-C1'),('WI-C','PRJ-C','Employee flow','Confirmed','facts','complete','verifier','Verifier',100,'','done',NULL,'confirmed',NULL,NULL,NULL);
  INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference) VALUES ('MAT-C','PRJ-C','MAT-C',1,'pdf','authorized','verified','project','BLD-C','WI-C','Evidence','ref://c');
  INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,material_status,status,source_refs_json) VALUES ('FACT-C','PRJ-C','WI-C','execution','Fact','steps','same','confirmed','["MAT-C"]');
  INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner) VALUES ('PKT-C1','PRJ-C',1,'revision_requested','BLD-C','[{"factId":"FACT-C","sourceRefs":["MAT-C"]}]','Risk','Pilot','["c"]','["m"]','["s"]','Owner');
`);
const invokeRace = async (key) => {
  const response = await draftPacket({ request: bearerRequest("http://127.0.0.1/api/formal/projects/PRJ-C/decision-packets/draft", "TOK-BLD-C", { ...draftBody, factRefs: [{ factId: "FACT-C" }] }, { "Idempotency-Key": key }), env: { DB: dbRace }, params: { projectId: "PRJ-C" } });
  return { status: response.status, body: JSON.parse(await response.text()) };
};
const competing = await Promise.all([invokeRace("draft-c-a"), invokeRace("draft-c-b")]);
assert.deepEqual(competing.map((entry) => entry.status).sort(), [201, 409]);
assert.equal(Number(dbRace.get("SELECT COUNT(*) AS count FROM decision_packets WHERE project_id='PRJ-C' AND version=2").count), 1);
assert.equal(dbRace.get("SELECT status FROM work_items WHERE id='REV-C'").status, "awaiting_verification");
dbRace.close();

const dbPause = new D1Harness();
dbPause.exec(`
  INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES ('PRJ-P','Pause','Scope','decision','active','L2','external_builder','BLD-P');
  INSERT INTO accounts(id,email,name,status) VALUES ('BLD-P','bp@example.invalid','Builder P','active'),('OWN-P','op@example.invalid','Owner P','active'),('EMP-P','ep@example.invalid','Employee P','active');
  INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES ('AUTH-P','PRJ-P','Test authorization','Owner P','op@example.invalid','synthetic','test://authorization','authorized','BLD-P','AUTH-P-KEY','nonce','hash','2099-01-01T00:00:00Z');
  INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('PRJ-P','BLD-P','external_builder','active'),('PRJ-P','OWN-P','owner','active'),('PRJ-P','EMP-P','employee','active');
  INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-OWN-P','OWN-P','PRJ-P','2099-01-01T00:00:00Z','REF-OWN-P');
  INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,source_employee_account_id,judgment_status) VALUES ('WI-P','PRJ-P','Employee flow','Confirmed','decision','awaiting_decision','owner','Owner P',100,'等待负责人决策','await decision','EMP-P','confirmed');
  INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,material_status,status,source_refs_json) VALUES ('FACT-P','PRJ-P','WI-P','execution','Fact','steps','same','confirmed','[]');
  INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,published_at) VALUES ('PKT-P','PRJ-P',1,'published','BLD-P','[{"factId":"FACT-P"}]','Risk','Pilot','["c"]','["m"]','["s"]','Owner','2026-08-25T02:00:00Z');
`);
const pausedResponse = await decidePacket({ request: bearerRequest("http://127.0.0.1/api/formal/decision-packets/PKT-P/owner-decision", "TOK-OWN-P", { ...revisionBody, decision: "pause", reason: "本季度暂不推进。" }, { "Idempotency-Key": "owner-pause" }), env: { DB: dbPause }, params: { packetId: "PKT-P" } });
assert.equal(pausedResponse.status, 200, await pausedResponse.text());
assert.equal(dbPause.get("SELECT status FROM work_items WHERE id='WI-P'").status, "complete");
assert.match(dbPause.get("SELECT next_action FROM work_items WHERE id='WI-P'").next_action, /暂停/);
dbPause.close();
db.close();
console.log("owner revision runtime: ok");
