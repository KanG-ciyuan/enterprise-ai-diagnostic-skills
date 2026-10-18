import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/work-items/[itemId]/evidence-supplement.js";
import { D1Harness } from "./d1_harness.mjs";

function seed(db) {
  db.exec(`
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role) VALUES ('PRJ-TEST','Test','Scope','facts','active','L2','owner');
    INSERT INTO accounts(id,email,name,status) VALUES ('ACT-ONE','one@example.invalid','One','active'),('ACT-TWO','two@example.invalid','Two','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES ('AUTH-TEST','PRJ-TEST','Test authorization','Owner','owner@example.invalid','synthetic','test://authorization','authorized','ACT-ONE','AUTH-TEST-KEY','nonce','hash','2099-01-01T00:00:00Z');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('PRJ-TEST','ACT-ONE','employee','active'),('PRJ-TEST','ACT-TWO','employee','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOKEN-ONE','ACT-ONE','PRJ-TEST','2099-01-01T00:00:00Z','REFRESH-ONE'),('TOKEN-TWO','ACT-TWO','PRJ-TEST','2099-01-01T00:00:00Z','REFRESH-TWO');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,evidence_version,judgment_status,supplement_id) VALUES ('WI-1','PRJ-TEST','Task','Task','facts','blocked','employee','Employee',40,'waiting','supplement',2,'blocked','SUP-1');
    INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,material_status,status,evidence_version) VALUES ('FACT-1','PRJ-TEST','WI-1','workflow','Claim','field','insufficient_evidence','insufficient_evidence',2);
    INSERT INTO evidence_supplements(id,work_item_id,fact_id,requested_material,responsible_person,deadline,recovery_entry,authorization_scope,source_refs,old_evidence_version,new_evidence_version,status) VALUES ('SUP-1','WI-1','FACT-1','Requested','Employee','2099-01-01T00:00:00Z','Reverify','project','[]',2,3,'waiting');
  `);
}

function requestFor(token) {
  return new Request("http://127.0.0.1/api/work-items/WI-1/evidence-supplement", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ material: "Evidence", reference: "REF-1", sourceType: "pdf" }),
  });
}

async function call(db, token) {
  const response = await onRequestPost({ request: requestFor(token), env: { DB: db }, params: { itemId: "WI-1" } });
  return { status: response.status, text: await response.text() };
}

function snapshot(db) {
  return {
    supplement: db.get("SELECT status,material_id,new_evidence_version FROM evidence_supplements WHERE id='SUP-1'"),
    materials: db.count("evidence_materials"),
    fact: db.get("SELECT status,material_status,evidence_version FROM candidate_facts WHERE id='FACT-1'"),
    item: db.get("SELECT status,judgment_status,evidence_version FROM work_items WHERE id='WI-1'"),
    events: db.count("events"),
    idempotency: db.count("idempotency_records"),
  };
}

async function verifySuccessfulReplayAndCompetition() {
  const db = new D1Harness();
  seed(db);
  const first = await call(db, "TOKEN-ONE");
  assert.equal(first.status, 200);
  const firstBody = JSON.parse(first.text);
  const state = snapshot(db);
  assert.equal(state.supplement.status, "provided");
  assert.equal(state.supplement.new_evidence_version, 3);
  assert.equal(state.materials, 1);
  assert.equal(state.fact.status, "open");
  assert.equal(state.fact.material_status, "unverified");
  assert.equal(state.fact.evidence_version, 3);
  assert.equal(state.item.status, "awaiting_verification");
  assert.equal(state.item.judgment_status, "open");
  assert.equal(state.item.evidence_version, 3);
  assert.equal(state.events, 1);
  assert.equal(state.idempotency, 1);
  assert.equal(firstBody.recovery.materialId, state.supplement.material_id);

  const replay = await call(db, "TOKEN-ONE");
  assert.equal(replay.status, 200);
  assert.deepEqual(JSON.parse(replay.text), firstBody);
  assert.deepEqual(snapshot(db), state);

  const competing = await call(db, "TOKEN-TWO");
  assert.equal(competing.status, 409);
  assert.equal(JSON.parse(competing.text).code, "transition_conflict");
  assert.deepEqual(snapshot(db), state);
  db.close();
}

async function verifyInjectedFailureRollsBack() {
  const db = new D1Harness();
  seed(db);
  const before = snapshot(db);
  db.failOnEvent = true;
  const failed = await call(db, "TOKEN-ONE");
  assert.equal(failed.status, 500);
  assert.deepEqual(snapshot(db), before);
  db.failOnEvent = false;
  const retry = await call(db, "TOKEN-ONE");
  assert.equal(retry.status, 200);
  assert.equal(snapshot(db).materials, 1);
  assert.equal(snapshot(db).events, 1);
  db.close();
}

await verifySuccessfulReplayAndCompetition();
await verifyInjectedFailureRollsBack();
console.log("evidence supplement runtime transitions: ok");
