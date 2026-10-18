import assert from "node:assert/strict";
import { onRequestPost as verifyPacket } from "../functions/api/formal/decision-packets/[packetId]/verify.js";
import { onRequestPost as publishPacket } from "../functions/api/formal/decision-packets/[packetId]/publish.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const db = new D1Harness();
db.exec(`
  INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role) VALUES ('PRJ-D','Decision','Scope','decision','active','L2','owner');
  INSERT INTO accounts(id,email,name,status) VALUES ('VER-1','v@example.invalid','Verifier','active'),('BLD-1','b@example.invalid','Builder','active');
  INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES ('AUTH-D','PRJ-D','Test authorization','Owner','owner@example.invalid','synthetic','test://authorization','authorized','BLD-1','AUTH-D-KEY','nonce','hash','2099-01-01T00:00:00Z');
  INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('PRJ-D','VER-1','verifier','active'),('PRJ-D','BLD-1','external_builder','active');
  INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-V','VER-1','PRJ-D','2099-01-01T00:00:00Z','REF-V'),('TOK-B','BLD-1','PRJ-D','2099-01-01T00:00:00Z','REF-B');
  INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,judgment_status) VALUES ('WI-D','PRJ-D','Task','Task','decision','awaiting_decision','owner','Owner',100,'none','decide','confirmed');
  INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference) VALUES ('MAT-D','PRJ-D','MAT-D',1,'pdf','authorized','verified','project','BLD-1','WI-D','Evidence','REF');
  INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,material_status,status,source_refs_json) VALUES ('FACT-UUID-123','PRJ-D','WI-D','workflow','Claim','field','same','confirmed','["MAT-D"]'),('FACT-BAD','PRJ-D','WI-D','workflow','Bad','field','unverified','open','["MAT-D"]');
  INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner) VALUES ('PKT-GOOD','PRJ-D',1,'draft','BLD-1','[{"factId":"FACT-UUID-123"}]','Risk','Pilot','["c"]','["m"]','["s"]','Owner'),('PKT-BAD','PRJ-D',2,'draft','BLD-1','[{"factId":"FACT-BAD"}]','Risk','Pilot','["c"]','["m"]','["s"]','Owner'),('PKT-DEGRADE','PRJ-D',3,'verifier_checked','BLD-1','[{"factId":"FACT-UUID-123"}]','Risk','Pilot','["c"]','["m"]','["s"]','Owner'),('PKT-FAIL','PRJ-D',4,'verifier_checked','BLD-1','[{"factId":"FACT-UUID-123"}]','Risk','Pilot','["c"]','["m"]','["s"]','Owner');
`);

async function invoke(handler, packetId, token, body = {}) {
  const response = await handler({ request: bearerRequest(`http://127.0.0.1/api/formal/decision-packets/${packetId}`, token, body), env: { DB: db }, params: { packetId } });
  return { status: response.status, body: JSON.parse(await response.text()) };
}

const [verified, verifyReplay] = await Promise.all([
  invoke(verifyPacket, "PKT-GOOD", "TOK-V", { factRefs: [{ factId: "FACT-UUID-123" }] }),
  invoke(verifyPacket, "PKT-GOOD", "TOK-V", { factRefs: [{ factId: "FACT-UUID-123" }] }),
]);
assert.equal(verified.status, 200);
assert.equal(verifyReplay.status, 200, JSON.stringify(verifyReplay.body));
assert.deepEqual(verifyReplay.body, verified.body);
assert.equal(Number(db.get("SELECT COUNT(*) AS count FROM idempotency_records WHERE action='decision-packet-verify'").count), 1);
assert.equal(db.get("SELECT status FROM decision_packets WHERE id='PKT-GOOD'").status, "verifier_checked");
const published = await invoke(publishPacket, "PKT-GOOD", "TOK-B");
assert.equal(published.status, 200);
assert.equal(db.get("SELECT status FROM decision_packets WHERE id='PKT-GOOD'").status, "published");
const publishedReplay = await invoke(publishPacket, "PKT-GOOD", "TOK-B");
assert.equal(publishedReplay.status, 200);
assert.deepEqual(publishedReplay.body, published.body);
assert.equal(Number(db.get("SELECT COUNT(*) AS count FROM events WHERE type='risk_summary_published' AND payload LIKE '%PKT-GOOD%'").count), 1);

const bad = await invoke(verifyPacket, "PKT-BAD", "TOK-V", { factRefs: [{ factId: "FACT-BAD" }] });
assert.equal(bad.status, 409);
assert.equal(db.get("SELECT status FROM decision_packets WHERE id='PKT-BAD'").status, "draft");

db.exec("UPDATE candidate_facts SET status='open' WHERE id='FACT-UUID-123'");
const degraded = await invoke(publishPacket, "PKT-DEGRADE", "TOK-B");
assert.equal(degraded.status, 409);
assert.equal(db.get("SELECT status FROM decision_packets WHERE id='PKT-DEGRADE'").status, "verifier_checked");

db.exec("UPDATE candidate_facts SET status='confirmed' WHERE id='FACT-UUID-123'");
const eventsBeforeFailure = db.count("events");
db.failOnEvent = true;
const failedPublish = await invoke(publishPacket, "PKT-FAIL", "TOK-B");
assert.equal(failedPublish.status, 500);
assert.equal(db.get("SELECT status FROM decision_packets WHERE id='PKT-FAIL'").status, "verifier_checked");
assert.equal(db.count("events"), eventsBeforeFailure);
db.failOnEvent = false;
db.close();
console.log("decision packet candidate fact runtime: ok");
