import assert from "node:assert/strict";
import { onRequestPost as createProject } from "../functions/api/projects.js";
import { onRequestPost as createInvitation } from "../functions/api/projects/[projectId]/invitations.js";
import { onRequestPost as confirmAuthorization } from "../functions/api/projects/[projectId]/authorizations/[authorizationId]/confirm.js";
import { onRequestPost as acceptInvitation } from "../functions/api/invitations/[invitationRef]/accept.js";
import { onRequestPost as bindAuthorization } from "../functions/api/projects/[projectId]/materials/[materialId]/authorization-binding.js";
import { onRequest as legacyOwnerDecision } from "../functions/api/work-items/[itemId]/owner-decision.js";
import { onRequestGet as listAuthorizations, onRequestPost as createAuthorization } from "../functions/api/projects/[projectId]/authorizations.js";
import { onRequestPost as resendAuthorization } from "../functions/api/projects/[projectId]/authorizations/[authorizationId]/resend.js";
import { onRequestGet as listMaterials, onRequestPost as createMaterial } from "../functions/api/projects/[projectId]/materials.js";
import { onRequestPost as reviewMaterial } from "../functions/api/projects/[projectId]/materials/[materialId]/review.js";
import { onRequestPut as saveEmployeeDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { onRequestPost as provideSupplement } from "../functions/api/work-items/[itemId]/evidence-supplement.js";
import { onRequestPost as verifyFact } from "../functions/api/work-items/[itemId]/verification.js";
import { onRequestPost as draftDecisionPacket } from "../functions/api/formal/projects/[projectId]/decision-packets/draft.js";
import { onRequestPost as verifyDecisionPacket } from "../functions/api/formal/decision-packets/[packetId]/verify.js";
import { onRequestPost as publishDecisionPacket } from "../functions/api/formal/decision-packets/[packetId]/publish.js";
import { onRequestPost as decideDecisionPacket } from "../functions/api/formal/decision-packets/[packetId]/owner-decision.js";
import { onRequestGet as listConfirmedFacts } from "../functions/api/formal/projects/[projectId]/confirmed-facts.js";
import { onRequestGet as getDecisionPacket } from "../functions/api/formal/projects/[projectId]/decision-packet.js";
import { onRequestPost as requestMemberLogin } from "../functions/api/auth/login-request.js";
import { onRequestPost as consumeMemberLogin } from "../functions/api/auth/login-consume.js";
import { onRequestPost as authorizeBuilder } from "../functions/api/auth/authorize.js";
import { onRequestGet as listVerifierCandidates } from "../functions/api/projects/[projectId]/verifier-candidates.js";
import { onRequestPost as reassignWorkItem } from "../functions/api/work-items/[itemId]/reassignment.js";
import { onRequestGet as listVerifierFacts } from "../functions/api/formal/projects/[projectId]/verifier-facts.js";
import { onRequest as listWorkItems } from "../functions/api/projects/[projectId]/work-items.js";
import { onRequest as getProjectDetail } from "../functions/api/projects/[projectId].js";
import { sha256 } from "../functions/_shared.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

async function call(handler, request, params, env) {
  const response = await handler({ request, params, env });
  return { status: response.status, headers: response.headers, body: JSON.parse(await response.text()) };
}

async function projectGate() {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO enterprises(id,name) VALUES ('ENT-GATE','Gate Test');
    INSERT INTO accounts(id,email,name,enterprise_id,status,account_role) VALUES ('BLD-GATE','builder@gate.invalid','Builder','ENT-GATE','active','external_builder');
    INSERT INTO sessions(token,account_id,expires_at,refresh_token) VALUES ('TOK-GATE','BLD-GATE','2099-01-01T00:00:00Z','REF-GATE');
  `);
  const delivered = [];
  const env = { DB: db, AUTHORIZATION_CONFIRMATION_HMAC_SECRET: "synthetic-test-secret", AUTHORIZATION_CONFIRMATION_QUEUE: { send: async (message) => delivered.push(message) } };
  const created = await call(createProject, bearerRequest("http://127.0.0.1/api/projects", "TOK-GATE", { name: "Draft diagnosis", scope: "Synthetic process" }, { "Idempotency-Key": "GATE-PROJECT" }), {}, env);
  assert.equal(created.status, 201);
  assert.equal(created.body.project.status, "draft");
  assert.equal(created.body.project.authorization_stage, "draft");
  const projectId = created.body.project.id;
  const invite = () => bearerRequest(`http://127.0.0.1/api/projects/${projectId}/invitations`, "TOK-GATE", { email: "employee@gate.invalid", role: "employee" }, { "Idempotency-Key": "GATE-INVITE" });
  const blocked = await call(createInvitation, invite(), { projectId }, env);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "enterprise_authorization_required");
  assert.equal(db.count("invitations"), 0);
  const authorizationCreated = await call(createAuthorization, bearerRequest(`http://127.0.0.1/api/projects/${projectId}/authorizations`, "TOK-GATE", { label: "Allowed before activation", authorizerName: "Owner", authorizerEmail: "owner@gate.invalid", scope: "synthetic", reference: "test://pre-authorization" }, { "Idempotency-Key": "GATE-AUTH-ALLOWED" }), { projectId }, env);
  assert.equal(authorizationCreated.status, 201, JSON.stringify(authorizationCreated.body));
  const allowedAuthorizationId = authorizationCreated.body.authorization.id;
  const authorizationList = await call(listAuthorizations, bearerRequest(`http://127.0.0.1/api/projects/${projectId}/authorizations`, "TOK-GATE"), { projectId }, env);
  assert.equal(authorizationList.status, 200);
  db.database.prepare("UPDATE authorization_notification_outbox SET created_at='2000-01-01 00:00:00' WHERE authorization_id=?").run(allowedAuthorizationId);
  const authorizationResent = await call(resendAuthorization, bearerRequest(`http://127.0.0.1/api/projects/${projectId}/authorizations/${allowedAuthorizationId}/resend`, "TOK-GATE", {}), { projectId, authorizationId: allowedAuthorizationId }, env);
  assert.equal(authorizationResent.status, 200, JSON.stringify(authorizationResent.body));
  assert.ok(delivered.length >= 2, "authorization delivery remains available while project is draft");
  const confirmationToken = "local-synthetic-confirmation-capability";
  const confirmationHash = await sha256(confirmationToken);
  db.prepare("INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at,confirmation_delivery_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'delivered')")
    .bind("AUTH-GATE", projectId, "Synthetic scope", "Owner", "owner@gate.invalid", "synthetic only", "test://authorization", "pending", "BLD-GATE", "AUTH-GATE-KEY", "nonce", confirmationHash, "2099-01-01T00:00:00Z").run();
  db.prepare("UPDATE projects SET authorization_stage='authorized' WHERE id=?").bind(projectId).run();
  const projectedOnly = await call(createInvitation, invite(), { projectId }, env);
  assert.equal(projectedOnly.status, 409, "delivery/project projection must not substitute for human authorization");
  assert.equal(projectedOnly.body.code, "enterprise_authorization_required");
  db.exec(`
    INSERT INTO accounts(id,email,name,enterprise_id,status) VALUES ('EMP-GATE','employee@gate.invalid','Employee','ENT-GATE','active'),('VER-GATE','verifier@gate.invalid','Verifier','ENT-GATE','active'),('OWN-GATE','owner@gate.invalid','Owner','ENT-GATE','active');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('${projectId}','EMP-GATE','employee','active'),('${projectId}','VER-GATE','verifier','active'),('${projectId}','OWN-GATE','owner','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-EMP-GATE','EMP-GATE','${projectId}','2099-01-01T00:00:00Z','REF-EMP-GATE'),('TOK-VER-GATE','VER-GATE','${projectId}','2099-01-01T00:00:00Z','REF-VER-GATE'),('TOK-OWN-GATE','OWN-GATE','${projectId}','2099-01-01T00:00:00Z','REF-OWN-GATE');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,status,expires_at) VALUES ('INV-LEGACY','invite-legacy', '${projectId}','BLD-GATE','legacy@gate.invalid','employee','pending','2099-01-01T00:00:00Z');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,source_employee_account_id,assigned_verifier_id,supplement_id) VALUES ('WI-MAP-GATE','${projectId}','Mapping','Synthetic','mapping','needs_input','employee','Employee',0,'','Map','EMP-GATE','EMP-GATE','VER-GATE','SUP-GATE'),('WI-GATE','${projectId}','Draft decision','Synthetic','decision','awaiting_decision','owner','Owner',100,'','Decide','OWN-GATE','EMP-GATE','VER-GATE',NULL);
    INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference) VALUES ('MAT-GATE','${projectId}','SUPMAT-GATE',1,'pdf','pending','pending','project','BLD-GATE','WI-MAP-GATE','Pending material','test://material');
    INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,material_status,status) VALUES ('FACT-GATE','${projectId}','WI-MAP-GATE','execution','Synthetic claim','steps','unverified','open');
    INSERT INTO evidence_supplements(id,work_item_id,fact_id,requested_material,responsible_person,responsible_account_id,deadline,recovery_entry,authorization_scope,source_refs,old_evidence_version,new_evidence_version,status) VALUES ('SUP-GATE','WI-MAP-GATE','FACT-GATE','Synthetic material','Employee','EMP-GATE','2099-01-01T00:00:00Z','Reverify','project','[]',1,2,'waiting');
    INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner) VALUES ('PKT-GATE','${projectId}',1,'draft','BLD-GATE','[]','Risk','Pilot','["c"]','["m"]','["s"]','Owner'),('PKT-PUBLISHED-GATE','${projectId}',2,'published','BLD-GATE','[]','Risk','Pilot','["c"]','["m"]','["s"]','Owner');
  `);
  const gateCases = [
    ["material list", listMaterials, bearerRequest(`http://127.0.0.1/api/projects/${projectId}/materials`, "TOK-GATE"), { projectId }],
    ["material create", createMaterial, bearerRequest(`http://127.0.0.1/api/projects/${projectId}/materials`, "TOK-GATE", { authorizationRecordId: "AUTH-GATE", label: "New", reference: "test://new", sourceType: "pdf", visibility: "project" }), { projectId }],
    ["material review", reviewMaterial, bearerRequest(`http://127.0.0.1/api/projects/${projectId}/materials/MAT-GATE/review`, "TOK-VER-GATE", { decision: "verified", reason: "Synthetic" }), { projectId, materialId: "MAT-GATE" }],
    ["employee draft", saveEmployeeDraft, new Request("http://127.0.0.1/api/work-items/WI-MAP-GATE/employee-draft", { method: "PUT", headers: { Authorization: "Bearer TOK-EMP-GATE", "content-type": "application/json" }, body: JSON.stringify({ answers: { trigger: "x" }, materialStatus: "provided" }) }), { itemId: "WI-MAP-GATE" }],
    ["employee submission", submitEmployee, bearerRequest("http://127.0.0.1/api/work-items/WI-MAP-GATE/employee-submission", "TOK-EMP-GATE", { text: "Synthetic", workflowCard: {}, materialStatus: "provided" }, { "Idempotency-Key": "GATE-SUBMIT" }), { itemId: "WI-MAP-GATE" }],
    ["evidence supplement", provideSupplement, bearerRequest("http://127.0.0.1/api/work-items/WI-MAP-GATE/evidence-supplement", "TOK-EMP-GATE", { material: "Synthetic", reference: "test://supplement", sourceType: "pdf" }), { itemId: "WI-MAP-GATE" }],
    ["fact verification", verifyFact, bearerRequest("http://127.0.0.1/api/work-items/WI-MAP-GATE/verification", "TOK-VER-GATE", { factId: "FACT-GATE", decision: "same", reason: "Synthetic", sourceRefs: [] }), { itemId: "WI-MAP-GATE" }],
    ["decision draft", draftDecisionPacket, bearerRequest(`http://127.0.0.1/api/formal/projects/${projectId}/decision-packets/draft`, "TOK-GATE", { factRefs: [] }, { "Idempotency-Key": "GATE-DRAFT" }), { projectId }],
    ["decision verify", verifyDecisionPacket, bearerRequest("http://127.0.0.1/api/formal/decision-packets/PKT-GATE/verify", "TOK-VER-GATE", { factRefs: [] }), { packetId: "PKT-GATE" }],
    ["decision publish", publishDecisionPacket, bearerRequest("http://127.0.0.1/api/formal/decision-packets/PKT-GATE/publish", "TOK-GATE", {}), { packetId: "PKT-GATE" }],
    ["decision owner", decideDecisionPacket, bearerRequest("http://127.0.0.1/api/formal/decision-packets/PKT-PUBLISHED-GATE/owner-decision", "TOK-OWN-GATE", { decision: "continue" }), { packetId: "PKT-PUBLISHED-GATE" }],
    ["confirmed fact read", listConfirmedFacts, bearerRequest(`http://127.0.0.1/api/formal/projects/${projectId}/confirmed-facts`, "TOK-GATE"), { projectId }],
    ["decision packet read", getDecisionPacket, bearerRequest(`http://127.0.0.1/api/formal/projects/${projectId}/decision-packet`, "TOK-GATE"), { projectId }],
  ];
  for (const [label, handler, request, params] of gateCases) {
    const result = await call(handler, request, params, env);
    assert.equal(result.status, 409, `${label} must remain blocked before authorization: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, "enterprise_authorization_required", label);
  }
  const blockedAccept = await call(acceptInvitation, new Request("http://127.0.0.1/api/invitations/invite-legacy/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "legacy@gate.invalid", name: "Legacy" }) }), { invitationRef: "invite-legacy" }, env);
  assert.equal(blockedAccept.status, 409);
  assert.equal(blockedAccept.body.code, "enterprise_authorization_required");
  const blockedBinding = await call(bindAuthorization, bearerRequest(`http://127.0.0.1/api/projects/${projectId}/materials/MAT-GATE/authorization-binding`, "TOK-GATE", { authorizationRecordId: "AUTH-GATE" }, { "Idempotency-Key": "GATE-BIND" }), { projectId, materialId: "MAT-GATE" }, env);
  assert.equal(blockedBinding.status, 409);
  const blockedLegacyDecision = await call(legacyOwnerDecision, new Request("http://127.0.0.1/api/work-items/WI-GATE/owner-decision", { method: "POST", headers: { "content-type": "application/json", "X-Demo-Role": "owner", "X-Demo-User": "demo-owner" }, body: JSON.stringify({ decision: "continue_pilot" }) }), { itemId: "WI-GATE" }, env);
  assert.equal(blockedLegacyDecision.status, 409);
  assert.equal(blockedLegacyDecision.body.code, "formal_decision_packet_required");
  assert.equal(db.get("SELECT status FROM work_items WHERE id='WI-GATE'").status, "awaiting_decision");
  const rollbackToken = "synthetic-rollback-capability";
  const rollbackHash = await sha256(rollbackToken);
  db.prepare("INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind("AUTH-ROLLBACK", projectId, "Rollback", "Owner", "owner@gate.invalid", "synthetic", "test://rollback", "pending", "BLD-GATE", "AUTH-ROLLBACK-KEY", "nonce", rollbackHash, "2099-01-01T00:00:00Z").run();
  db.failSqlOncePattern = /UPDATE projects SET authorization_stage/;
  const rolledBack = await call(confirmAuthorization, new Request(`http://127.0.0.1/api/projects/${projectId}/authorizations/AUTH-ROLLBACK/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationToken: rollbackToken, decision: "authorized", reason: "Injected rollback" }) }), { projectId, authorizationId: "AUTH-ROLLBACK" }, env);
  assert.equal(rolledBack.status, 500);
  assert.equal(db.get("SELECT status FROM enterprise_authorizations WHERE id='AUTH-ROLLBACK'").status, "pending");
  assert.equal(db.get("SELECT status FROM projects WHERE id=?", projectId).status, "draft");
  const confirmed = await call(confirmAuthorization, new Request(`http://127.0.0.1/api/projects/${projectId}/authorizations/AUTH-GATE/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationToken, decision: "authorized", reason: "Synthetic acceptance approval" }) }), { projectId, authorizationId: "AUTH-GATE" }, env);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  let openedProject = db.get("SELECT authorization_stage,status FROM projects WHERE id=?", projectId);
  assert.equal(openedProject.authorization_stage, "authorized");
  assert.equal(openedProject.status, "active");
  const formalLegacyDecision = await call(legacyOwnerDecision, bearerRequest("http://127.0.0.1/api/work-items/WI-GATE/owner-decision", "TOK-OWN-GATE", { decision: "continue_pilot" }), { itemId: "WI-GATE" }, env);
  assert.equal(formalLegacyDecision.status, 409);
  assert.equal(formalLegacyDecision.body.code, "formal_decision_packet_required");
  assert.equal(db.get("SELECT status FROM work_items WHERE id='WI-GATE'").status, "awaiting_decision");
  db.prepare("UPDATE projects SET authorization_stage='draft',status='draft' WHERE id=?").bind(projectId).run();
  const readWithMismatchedProjection = await call(listMaterials, bearerRequest(`http://127.0.0.1/api/projects/${projectId}/materials`, "TOK-GATE"), { projectId }, env);
  assert.equal(readWithMismatchedProjection.status, 200);
  const unchangedProjection = db.get("SELECT authorization_stage,status FROM projects WHERE id=?", projectId);
  assert.equal(unchangedProjection.authorization_stage, "draft", "authorization guard must never mutate projection during a read");
  assert.equal(unchangedProjection.status, "draft");
  db.prepare("UPDATE projects SET authorization_stage='authorized',status='active' WHERE id=?").bind(projectId).run();
  const allowed = await call(createInvitation, invite(), { projectId }, env);
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  openedProject = db.get("SELECT authorization_stage,status FROM projects WHERE id=?", projectId);
  assert.equal(openedProject.authorization_stage, "authorized");
  assert.equal(openedProject.status, "active");
  db.close();
}

async function reauthentication() {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO enterprises(id,name) VALUES ('ENT-REAUTH','Reauthentication Test');
    INSERT INTO accounts(id,email,name,enterprise_id,status) VALUES
      ('MEM-REAUTH','member@reauth.invalid','Member','ENT-REAUTH','active'),
      ('DIS-REAUTH','disabled@reauth.invalid','Disabled','ENT-REAUTH','disabled');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage)
      VALUES ('PRJ-REAUTH','Recovery project','Sales handoff','scope','active','L2','external_builder','MEM-REAUTH','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES
      ('PRJ-REAUTH','MEM-REAUTH','verifier','active'),
      ('PRJ-REAUTH','DIS-REAUTH','owner','active');
  `);
  const inbox = [];
  const eventsBefore = db.count("events");
  const env = {
    DB: db,
    LOGIN_CHALLENGE_TEST_INBOX: inbox,
    LOGIN_CHALLENGE_PROVIDER: { send: async (message) => inbox.push(message) },
    // D-3：模式判定改为白名单；测试需显式 development，否则按生产语义拒绝开通。
    FORMAL_AUTH_MODE: "development",
    FORMAL_AUTH_TEST_MODE: "1",
  };

  const unknown = await call(requestMemberLogin, new Request("http://127.0.0.1/api/auth/login-request", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "unknown@reauth.invalid" }),
  }), {}, env);
  assert.equal(unknown.status, 202);
  assert.equal(unknown.body.accepted, true);
  assert.equal(inbox.length, 0, "unknown email must not produce a notification");

  const requested = await call(requestMemberLogin, new Request("http://127.0.0.1/api/auth/login-request", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "member@reauth.invalid" }),
  }), {}, env);
  assert.equal(requested.status, 202);
  assert.equal(requested.body.accepted, true);
  assert.equal(requested.body.token, undefined, "challenge token must not be returned by the API");
  assert.equal(inbox.length, 1);
  const challenge = inbox[0];
  assert.equal(challenge.to, "member@reauth.invalid");
  assert.ok(challenge.token, "isolated provider retains the token for local acceptance only");
  assert.match(challenge.loginUrl, /#login=/);
  assert.equal(new URL(challenge.loginUrl, "http://127.0.0.1").search, "");
  const challengeRow = db.get("SELECT * FROM member_login_challenges WHERE account_id='MEM-REAUTH'");
  assert.ok(challengeRow);
  assert.equal(challengeRow.token_hash, await sha256(challenge.token));
  assert.equal(db.count("events"), eventsBefore, "login recovery must not emit a token-bearing event");
  const storedDump = JSON.stringify(challengeRow);
  assert.equal(storedDump.includes(challenge.token), false, "raw token must not be stored in D1");

  const consumed = await call(consumeMemberLogin, new Request("http://127.0.0.1/api/auth/login-consume", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: challenge.token }),
  }), {}, env);
  assert.equal(consumed.status, 200, JSON.stringify(consumed.body));
  assert.equal(consumed.body.token, undefined);
  assert.equal(consumed.body.sessionToken, undefined);
  assert.equal(consumed.body.account.id, "MEM-REAUTH");
  assert.deepEqual(consumed.body.memberships.map((membership) => membership.role), ["verifier"]);
  assert.equal(consumed.body.memberships[0].projectId, "PRJ-REAUTH");
  assert.match(consumed.headers.get("set-cookie") || "", /HttpOnly/);
  assert.match(consumed.headers.get("set-cookie") || "", /Secure/);
  assert.match(consumed.headers.get("set-cookie") || "", /SameSite=Lax/);
  assert.equal(db.get("SELECT consumed_at FROM member_login_challenges WHERE id=?", challengeRow.id).consumed_at !== null, true);

  const repeated = await call(consumeMemberLogin, new Request("http://127.0.0.1/api/auth/login-consume", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: challenge.token }),
  }), {}, env);
  assert.equal(repeated.status, 401);

  const expiredRequest = await call(requestMemberLogin, new Request("http://127.0.0.1/api/auth/login-request", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "member@reauth.invalid" }),
  }), {}, env);
  assert.equal(expiredRequest.status, 202);
  const expiredToken = inbox.at(-1).token;
  db.prepare("UPDATE member_login_challenges SET expires_at=? WHERE token_hash=?").bind("2000-01-01T00:00:00Z", await sha256(expiredToken)).run();
  const expired = await call(consumeMemberLogin, new Request("http://127.0.0.1/api/auth/login-consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: expiredToken }) }), {}, env);
  assert.equal(expired.status, 401);

  db.prepare("UPDATE member_login_challenges SET created_at=datetime('now','-10 minutes') WHERE account_id='MEM-REAUTH'").run();
  const inboxBeforeResend = inbox.length;
  const resend = await call(requestMemberLogin, new Request("http://127.0.0.1/api/auth/login-request", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "member@reauth.invalid" }),
  }), {}, env);
  assert.equal(resend.status, 202);
  assert.equal(inbox.length, inboxBeforeResend + 1, "resend after cooldown must deliver one replacement link");

  const disabledAfterRequest = await call(requestMemberLogin, new Request("http://127.0.0.1/api/auth/login-request", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "member@reauth.invalid" }),
  }), {}, env);
  assert.equal(disabledAfterRequest.status, 202);
  const disabledToken = inbox.at(-1).token;
  db.prepare("UPDATE accounts SET status='disabled' WHERE id='MEM-REAUTH'").run();
  const disabledConsume = await call(consumeMemberLogin, new Request("http://127.0.0.1/api/auth/login-consume", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: disabledToken }),
  }), {}, env);
  assert.equal(disabledConsume.status, 401);
  db.prepare("UPDATE accounts SET status='active' WHERE id='MEM-REAUTH'").run();

  const inboxBeforeDisabled = inbox.length;
  const disabled = await call(requestMemberLogin, new Request("http://127.0.0.1/api/auth/login-request", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "disabled@reauth.invalid" }),
  }), {}, env);
  assert.equal(disabled.status, 202);
  assert.equal(inbox.length, inboxBeforeDisabled, "disabled accounts must not produce a challenge");

  // bootstrapToken must now be the real development test code: V0.1 第一批 removed the
  // unconditional bypass where TEST_MODE=1 skipped the token check, so the previous
  // placeholder string was rejected before reaching the email-hijack guard asserted below.
  const bootstrapExisting = await call(authorizeBuilder, new Request("http://127.0.0.1/api/auth/authorize", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "member@reauth.invalid", enterpriseName: "Reauthentication Test", bootstrapToken: "123456" }),
  }), {}, env);
  assert.equal(bootstrapExisting.status, 409);
  assert.equal(bootstrapExisting.body.code, "account_exists");
  db.close();
}

async function reassignment() {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO enterprises(id,name) VALUES ('ENT-RA','Reassignment Test');
    INSERT INTO accounts(id,email,name,enterprise_id,status) VALUES
      ('BLD-RA','builder@ra.invalid','Builder','ENT-RA','active'),
      ('VER-A','a@ra.invalid','Verifier A','ENT-RA','active'),
      ('VER-B','b@ra.invalid','Verifier B','ENT-RA','active'),
      ('VER-C','c@ra.invalid','Verifier C','ENT-RA','active'),
      ('VER-INACTIVE','inactive@ra.invalid','Verifier Inactive','ENT-RA','active'),
      ('VER-OFF','off@ra.invalid','Verifier Offline','ENT-RA','disabled'),
      ('VER-OTHER','other@ra.invalid','Verifier Other','ENT-RA','active'),
      ('EMP-RA','employee@ra.invalid','Employee','ENT-RA','active');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES
      ('PRJ-RA','Reassignment','Synthetic handoff','facts','active','L2','external_builder','BLD-RA','authorized'),
      ('PRJ-LOCKED','Locked project','Synthetic handoff','facts','draft','L2','external_builder','BLD-RA','draft'),
      ('PRJ-OTHER','Other project','Synthetic handoff','facts','active','L2','external_builder','BLD-RA','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES
      ('PRJ-RA','BLD-RA','external_builder','active'),
      ('PRJ-RA','VER-A','verifier','active'),
      ('PRJ-RA','VER-B','verifier','active'),
      ('PRJ-RA','VER-C','verifier','active'),
      ('PRJ-RA','VER-INACTIVE','verifier','inactive'),
      ('PRJ-RA','VER-OFF','verifier','active'),
      ('PRJ-RA','EMP-RA','employee','active'),
      ('PRJ-LOCKED','BLD-RA','external_builder','active'),
      ('PRJ-LOCKED','VER-B','verifier','active'),
      ('PRJ-OTHER','VER-OTHER','verifier','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('TOK-BLD-RA','BLD-RA','PRJ-RA','2099-01-01T00:00:00Z','REF-BLD-RA'),
      ('TOK-A-RA','VER-A','PRJ-RA','2099-01-01T00:00:00Z','REF-A-RA'),
      ('TOK-B-RA','VER-B','PRJ-RA','2099-01-01T00:00:00Z','REF-B-RA'),
      ('TOK-C-RA','VER-C','PRJ-RA','2099-01-01T00:00:00Z','REF-C-RA'),
      ('TOK-EMP-RA','EMP-RA','PRJ-RA','2099-01-01T00:00:00Z','REF-EMP-RA'),
      ('TOK-BLD-LOCKED','BLD-RA','PRJ-LOCKED','2099-01-01T00:00:00Z','REF-BLD-LOCKED');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-RA','PRJ-RA','Synthetic authorization','Owner','owner@ra.invalid','synthetic','test://authorization','authorized','BLD-RA','AUTH-RA-KEY','nonce','hash','2099-01-01T00:00:00Z');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,source_employee_account_id,assigned_verifier_id,assignment_version,evidence_json,evidence_version,flow_card_version,judgment_status) VALUES
      ('WI-RA','PRJ-RA','Verify customer handoff','Synthetic','facts','awaiting_verification','verifier','Verifier A',80,'','Verify','VER-A','EMP-RA','VER-A',1,'[{"id":"E-1"}]',4,3,'open'),
      ('WI-RACE-RA','PRJ-RA','Concurrent verification','Synthetic','facts','awaiting_verification','verifier','Verifier A',80,'','Verify','VER-A','EMP-RA','VER-A',1,'[]',1,1,'open'),
      ('WI-FINAL-RA','PRJ-RA','Completed verification','Synthetic','facts','complete','verifier','Verifier A',100,'','Done','VER-A','EMP-RA','VER-A',1,'[]',1,1,'confirmed'),
      ('WI-LOCKED-RA','PRJ-LOCKED','Locked verification','Synthetic','facts','blocked','verifier','Verifier B',60,'Waiting','Verify','VER-B','EMP-RA','VER-B',1,'[]',1,1,'blocked');
    INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,material_status,status,source_refs_json,flow_card_version,evidence_version)
      VALUES ('FACT-RA','PRJ-RA','WI-RA','execution','Synthetic claim','steps','unverified','open','["MAT-RA"]',3,4);
    INSERT INTO fact_judgments(id,work_item_id,fact_id,decision,reason,source_refs,actor_id,flow_card_version,evidence_version)
      VALUES ('JDG-RA','WI-RA','FACT-RA','insufficient_evidence','Historical reason','["MAT-RA"]','VER-A',3,4);
    INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference)
      VALUES ('MAT-RA','PRJ-RA','MAT-KEY-RA',4,'pdf','AUTH-RA','authorized','verified','verifier','BLD-RA','WI-RA','Historical evidence','test://evidence');
    INSERT INTO evidence_supplements(id,work_item_id,fact_id,requested_material,responsible_person,responsible_account_id,deadline,recovery_entry,authorization_scope,source_refs,old_evidence_version,new_evidence_version,status)
      VALUES ('SUP-RA','WI-RA','FACT-RA','Historical supplement','Employee','EMP-RA','2099-03-04T00:00:00Z','Recheck FACT-RA','project','["MAT-RA"]',3,4,'waiting');
    INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,material_status,status,source_refs_json,flow_card_version,evidence_version)
      VALUES ('FACT-RACE-RA','PRJ-RA','WI-RACE-RA','execution','Concurrent claim','steps','unverified','open','["MAT-RACE-RA"]',1,1);
    INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference)
      VALUES ('MAT-RACE-RA','PRJ-RA','MAT-KEY-RACE-RA',1,'pdf','AUTH-RA','authorized','verified','verifier','BLD-RA','WI-RACE-RA','Concurrent evidence','test://race-evidence');
  `);
  const env = { DB: db };
  const invoke = (handler, request, params) => call(handler, request, params, env);

  const candidates = await invoke(listVerifierCandidates, bearerRequest("http://127.0.0.1/api/projects/PRJ-RA/verifier-candidates", "TOK-BLD-RA"), { projectId: "PRJ-RA" });
  assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
  assert.deepEqual(candidates.body.candidates.map((entry) => entry.accountId), ["VER-A", "VER-B", "VER-C"]);
  const employeeCandidates = await invoke(listVerifierCandidates, bearerRequest("http://127.0.0.1/api/projects/PRJ-RA/verifier-candidates", "TOK-EMP-RA"), { projectId: "PRJ-RA" });
  assert.equal(employeeCandidates.status, 403, "only the external builder can list verifier candidates");
  const lockedCandidates = await invoke(listVerifierCandidates, bearerRequest("http://127.0.0.1/api/projects/PRJ-LOCKED/verifier-candidates", "TOK-BLD-LOCKED"), { projectId: "PRJ-LOCKED" });
  assert.equal(lockedCandidates.status, 409);
  assert.equal(lockedCandidates.body.code, "enterprise_authorization_required");

  const post = (token, itemId, body, key) => invoke(reassignWorkItem, bearerRequest(`http://127.0.0.1/api/work-items/${itemId}/reassignment`, token, body, key ? { "Idempotency-Key": key } : {}), { itemId });
  assert.equal((await post("TOK-BLD-RA", "WI-RA", { targetVerifierId: "VER-B", assignmentVersion: 1, reason: "" }, "RA-NO-REASON")).status, 422);
  assert.equal((await post("TOK-BLD-RA", "WI-RA", { targetVerifierId: "VER-B", assignmentVersion: 1, reason: "Capacity handoff" })).status, 422);
  assert.equal((await post("TOK-BLD-RA", "WI-RA", { targetVerifierId: "VER-A", assignmentVersion: 1, reason: "Same verifier" }, "RA-SAME")).status, 422);
  assert.equal((await post("TOK-BLD-RA", "WI-RA", { targetVerifierId: "VER-OFF", assignmentVersion: 1, reason: "Inactive verifier" }, "RA-OFF")).status, 422);
  assert.equal((await post("TOK-BLD-RA", "WI-RA", { targetVerifierId: "VER-OTHER", assignmentVersion: 1, reason: "Other project" }, "RA-OTHER")).status, 422);
  assert.equal((await post("TOK-EMP-RA", "WI-RA", { targetVerifierId: "VER-B", assignmentVersion: 1, reason: "Forbidden" }, "RA-EMP")).status, 403);
  assert.equal((await post("TOK-BLD-RA", "WI-FINAL-RA", { targetVerifierId: "VER-B", assignmentVersion: 1, reason: "Too late" }, "RA-FINAL")).status, 409);
  const staleFinal = await post("TOK-BLD-RA", "WI-FINAL-RA", { targetVerifierId: "VER-B", assignmentVersion: 0, reason: "Stale final view" }, "RA-FINAL-STALE");
  assert.equal(staleFinal.status, 409);
  assert.equal(staleFinal.body.code, "assignment_conflict");
  assert.equal(staleFinal.body.assignment.assignmentVersion, 1);
  const locked = await post("TOK-BLD-LOCKED", "WI-LOCKED-RA", { targetVerifierId: "VER-B", assignmentVersion: 1, reason: "Locked" }, "RA-LOCKED");
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, "enterprise_authorization_required");

  const [raceVerify, raceReassign] = await Promise.all([
    invoke(verifyFact, bearerRequest("http://127.0.0.1/api/work-items/WI-RACE-RA/verification", "TOK-A-RA", { factId: "FACT-RACE-RA", decision: "same", reason: "Concurrent verification", sourceRefs: ["MAT-RACE-RA"] }), { itemId: "WI-RACE-RA" }),
    post("TOK-BLD-RA", "WI-RACE-RA", { targetVerifierId: "VER-B", assignmentVersion: 1, reason: "Concurrent reassignment" }, "RA-VERIFY-RACE"),
  ]);
  assert.deepEqual([raceVerify.status, raceReassign.status].sort(), [200, 409], "verification and reassignment race must have one successful writer");
  const raceItem = db.get("SELECT assigned_verifier_id,assignee_account_id,assignment_version,status,stage FROM work_items WHERE id='WI-RACE-RA'");
  if (raceReassign.status === 200) assert.deepEqual({ ...raceItem }, { assigned_verifier_id: "VER-B", assignee_account_id: "VER-B", assignment_version: 2, status: "awaiting_verification", stage: "facts" });

  const stale = await post("TOK-BLD-RA", "WI-RA", { targetVerifierId: "VER-B", assignmentVersion: 0, reason: "Stale view" }, "RA-STALE");
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "assignment_conflict");
  assert.deepEqual(stale.body.assignment, { workItemId: "WI-RA", assignedVerifierId: "VER-A", assignedVerifierName: "Verifier A", assigneeAccountId: "VER-A", assigneeLabel: "Verifier A", assignmentVersion: 1 });

  const invariantsBefore = {
    workItem: db.get("SELECT status,stage,evidence_json,evidence_version,flow_card_version,judgment_status FROM work_items WHERE id='WI-RA'"),
    fact: db.get("SELECT material_status,status,source_refs_json,flow_card_version,evidence_version FROM candidate_facts WHERE id='FACT-RA'"),
    judgment: db.get("SELECT * FROM fact_judgments WHERE id='JDG-RA'"),
    material: db.get("SELECT * FROM evidence_materials WHERE id='MAT-RA'"),
    supplement: db.get("SELECT * FROM evidence_supplements WHERE id='SUP-RA'"),
  };
  const requestB = { targetVerifierId: "VER-B", assignmentVersion: 1, reason: "Balance the pending verification queue" };
  const requestC = { targetVerifierId: "VER-C", assignmentVersion: 1, reason: "Cover the pending verification deadline" };
  const [raceB, raceC] = await Promise.all([
    post("TOK-BLD-RA", "WI-RA", requestB, "RA-RACE-B"),
    post("TOK-BLD-RA", "WI-RA", requestC, "RA-RACE-C"),
  ]);
  assert.deepEqual([raceB.status, raceC.status].sort(), [200, 409], "concurrent reassignment must have one winner");
  const winner = raceB.status === 200 ? { response: raceB, body: requestB, key: "RA-RACE-B", token: "TOK-B-RA" } : { response: raceC, body: requestC, key: "RA-RACE-C", token: "TOK-C-RA" };
  const winnerId = winner.body.targetVerifierId;
  const winnerName = winnerId === "VER-B" ? "Verifier B" : "Verifier C";
  assert.deepEqual(winner.response.body.reassignment, {
    workItemId: "WI-RA", fromVerifierId: "VER-A", fromVerifierName: "Verifier A", toVerifierId: winnerId, toVerifierName: winnerName,
    reason: winner.body.reason, assignmentVersion: 2, eventId: "EVT-REASSIGN-WI-RA-2",
  });
  assert.equal(winner.response.body.item.assignmentVersion, 2);
  assert.deepEqual({ ...db.get("SELECT assigned_verifier_id,assignee_account_id,assignee_label,assignment_version FROM work_items WHERE id='WI-RA'") }, {
    assigned_verifier_id: winnerId, assignee_account_id: winnerId, assignee_label: winnerName, assignment_version: 2,
  });
  const builderDetail = await invoke(getProjectDetail, bearerRequest("http://127.0.0.1/api/projects/PRJ-RA", "TOK-BLD-RA"), { projectId: "PRJ-RA" });
  assert.equal(builderDetail.body.tasks.find((entry) => entry.id === "WI-RA").assignedVerifierName, winnerName);
  assert.equal(Number(db.get("SELECT COUNT(*) AS count FROM events WHERE work_item_id='WI-RA' AND type='work_item_reassigned'").count), 1);
  assert.equal(Number(db.get("SELECT COUNT(*) AS count FROM idempotency_records WHERE project_id='PRJ-RA' AND action='work-item-reassignment'").count), 1);
  assert.deepEqual({
    workItem: db.get("SELECT status,stage,evidence_json,evidence_version,flow_card_version,judgment_status FROM work_items WHERE id='WI-RA'"),
    fact: db.get("SELECT material_status,status,source_refs_json,flow_card_version,evidence_version FROM candidate_facts WHERE id='FACT-RA'"),
    judgment: db.get("SELECT * FROM fact_judgments WHERE id='JDG-RA'"),
    material: db.get("SELECT * FROM evidence_materials WHERE id='MAT-RA'"),
    supplement: db.get("SELECT * FROM evidence_supplements WHERE id='SUP-RA'"),
  }, invariantsBefore, "reassignment must preserve judgments, evidence, deadline, and fact state");

  const replay = await post("TOK-BLD-RA", "WI-RA", winner.body, winner.key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, winner.response.body);
  assert.equal(Number(db.get("SELECT COUNT(*) AS count FROM events WHERE work_item_id='WI-RA' AND type='work_item_reassigned'").count), 1);
  const sameKeyTarget = winnerId === "VER-B" ? "VER-C" : "VER-B";
  const [sameKeyReplay, sameKeyMismatch] = await Promise.all([
    post("TOK-BLD-RA", "WI-RA", winner.body, winner.key),
    post("TOK-BLD-RA", "WI-RA", { targetVerifierId: sameKeyTarget, assignmentVersion: 1, reason: "Different payload under same key" }, winner.key),
  ]);
  assert.deepEqual([sameKeyReplay.status, sameKeyMismatch.status].sort(), [200, 409], "same idempotency key with different payload must have one replay and one conflict");
  assert.equal(sameKeyMismatch.body.code, "idempotency_conflict");
  const staleAfterRace = await post("TOK-BLD-RA", "WI-RA", { targetVerifierId: "VER-A", assignmentVersion: 1, reason: "Stale reversal" }, "RA-STALE-AFTER");
  assert.equal(staleAfterRace.status, 409);
  assert.deepEqual(staleAfterRace.body.assignment, { workItemId: "WI-RA", assignedVerifierId: winnerId, assignedVerifierName: winnerName, assigneeAccountId: winnerId, assigneeLabel: winnerName, assignmentVersion: 2 });

  const oldQueue = await invoke(listVerifierFacts, bearerRequest("http://127.0.0.1/api/formal/projects/PRJ-RA/verifier-facts", "TOK-A-RA"), { projectId: "PRJ-RA" });
  const newQueue = await invoke(listVerifierFacts, bearerRequest("http://127.0.0.1/api/formal/projects/PRJ-RA/verifier-facts", winner.token), { projectId: "PRJ-RA" });
  assert.equal(oldQueue.body.facts.some((entry) => entry.workItemId === "WI-RA"), false);
  assert.equal(oldQueue.body.materials.some((entry) => entry.work_item_id === "WI-RA"), false, "transferred task material must not remain in old verifier payload");
  assert.ok(oldQueue.body.history.some((entry) => entry.judgmentId === "JDG-RA"), "old verifier must retain a read-only signed judgment history");
  assert.equal(newQueue.body.facts.some((entry) => entry.workItemId === "WI-RA"), true);
  const oldItems = await invoke(listWorkItems, bearerRequest("http://127.0.0.1/api/projects/PRJ-RA/work-items", "TOK-A-RA"), { projectId: "PRJ-RA" });
  const newItems = await invoke(listWorkItems, bearerRequest("http://127.0.0.1/api/projects/PRJ-RA/work-items", winner.token), { projectId: "PRJ-RA" });
  assert.equal(oldItems.body.items.some((entry) => entry.id === "WI-RA"), false);
  assert.equal(newItems.body.items.some((entry) => entry.id === "WI-RA"), true);
  const oldWrite = await invoke(verifyFact, bearerRequest("http://127.0.0.1/api/work-items/WI-RA/verification", "TOK-A-RA", {}), { itemId: "WI-RA" });
  const newWrite = await invoke(verifyFact, bearerRequest("http://127.0.0.1/api/work-items/WI-RA/verification", winner.token, {}), { itemId: "WI-RA" });
  assert.equal(oldWrite.status, 403);
  assert.equal(newWrite.status, 422, "new verifier reaches payload validation after assignment authorization");
  db.close();
}

const requestedSection = process.argv.includes("--section") ? process.argv[process.argv.indexOf("--section") + 1] : "all";
if (["all", "project-gate"].includes(requestedSection)) await projectGate();
if (["all", "reauthentication"].includes(requestedSection)) await reauthentication();
if (["all", "reassignment"].includes(requestedSection)) await reassignment();
console.log(`acceptance remediation runtime (${requestedSection}): ok`);
