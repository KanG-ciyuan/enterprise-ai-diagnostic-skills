import assert from "node:assert/strict";
import { onRequestGet as listAuthorizations, onRequestPost as createAuthorization } from "../functions/api/projects/[projectId]/authorizations.js";
import { onRequestPost as resendAuthorization } from "../functions/api/projects/[projectId]/authorizations/[authorizationId]/resend.js";
import { onRequestGet as getAuthorizationSummary, onRequestPost as confirmAuthorization } from "../functions/api/projects/[projectId]/authorizations/[authorizationId]/confirm.js";
import consumer from "../workers/authorization-confirmation-consumer.js";
import dlq from "../workers/authorization-confirmation-dlq.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const db = new D1Harness();
db.exec(`
  INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role) VALUES ('PRJ-A','Auth','Scope','evidence','active','L2','owner');
  INSERT INTO accounts(id,email,name,status) VALUES ('BLD-A','b@example.invalid','Builder','active'),('VER-A','v@example.invalid','Verifier','active'),('EMP-A','e@example.invalid','Employee','active'),('OWN-A','o@example.invalid','Owner','active');
  INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('PRJ-A','BLD-A','external_builder','active'),('PRJ-A','VER-A','verifier','active'),('PRJ-A','EMP-A','employee','active'),('PRJ-A','OWN-A','owner','active');
  INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-B','BLD-A','PRJ-A','2099-01-01T00:00:00Z','REF-B'),('TOK-V','VER-A','PRJ-A','2099-01-01T00:00:00Z','REF-V'),('TOK-E','EMP-A','PRJ-A','2099-01-01T00:00:00Z','REF-E'),('TOK-O','OWN-A','PRJ-A','2099-01-01T00:00:00Z','REF-O');
`);
const sent = [];
const env = { DB: db, AUTHORIZATION_CONFIRMATION_HMAC_SECRET: "test-only-secret", AUTHORIZATION_CONFIRMATION_QUEUE: { async send(body) { sent.push(structuredClone(body)); } } };
const createBody = { label: "CRM export approval", authorizerName: "Jane Approver", authorizerEmail: "JANE@EXAMPLE.INVALID", scope: "CRM export", reference: "EXT-REF" };

async function invoke(handler, request, params) {
  const response = await handler({ request, env, params });
  return { status: response.status, text: await response.text() };
}
const projectParams = { projectId: "PRJ-A" };
const createRequest = () => bearerRequest("http://127.0.0.1/api/projects/PRJ-A/authorizations", "TOK-B", createBody, { "Idempotency-Key": "CREATE-1" });
const first = await invoke(createAuthorization, createRequest(), projectParams);
assert.equal(first.status, 201);
const firstBody = JSON.parse(first.text);
assert.equal(db.count("enterprise_authorizations"), 1);
assert.equal(db.count("idempotency_records"), 1);
assert.equal(sent.length, 1);

assert(!first.text.includes(sent[0].confirmationToken));
const authorizationId = firstBody.authorization.id;
const initial = db.get("SELECT * FROM enterprise_authorizations WHERE id=?", authorizationId);
assert.equal(initial.authorizer_name, "Jane Approver");
assert.equal(initial.authorizer_email, "jane@example.invalid");
assert(new Date(initial.confirmation_token_expires_at) > new Date());
assert.notEqual(initial.confirmation_token_hash, sent[0].confirmationToken);
assert(!JSON.stringify(initial).includes(sent[0].confirmationToken));

const replay = await invoke(createAuthorization, createRequest(), projectParams);
assert.equal(replay.status, 201);
assert.deepEqual(JSON.parse(replay.text), firstBody);
assert.equal(db.count("enterprise_authorizations"), 1);
assert.equal(db.count("idempotency_records"), 1);
assert.equal(sent.length, 1);

const concurrentRequest = () => bearerRequest("http://127.0.0.1/api/projects/PRJ-A/authorizations", "TOK-B", createBody, { "Idempotency-Key": "CREATE-2" });
const [concurrentOne, concurrentTwo] = await Promise.all([
  invoke(createAuthorization, concurrentRequest(), projectParams),
  invoke(createAuthorization, concurrentRequest(), projectParams),
]);
assert.equal(concurrentOne.status, 201);
assert.equal(concurrentTwo.status, 201);
assert.deepEqual(JSON.parse(concurrentOne.text), JSON.parse(concurrentTwo.text));
assert.equal(db.count("enterprise_authorizations"), 2);
assert.equal(db.count("idempotency_records"), 2);
assert.equal(new Set(sent.map((message) => message.notificationId)).size, 2);

async function list(token) {
  return invoke(listAuthorizations, bearerRequest("http://127.0.0.1/api/projects/PRJ-A/authorizations", token), projectParams);
}
const builderList = await list("TOK-B");
assert.equal(builderList.status, 200);
assert.equal(JSON.parse(builderList.text).authorizations[0].authorizerEmail, "jane@example.invalid");
assert.equal(JSON.parse(builderList.text).authorizations[0].reference, "EXT-REF");
const verifierList = await list("TOK-V");
assert.equal(verifierList.status, 200);
const verifierRow = JSON.parse(verifierList.text).authorizations[0];
for (const sensitive of ["authorizerName", "authorizerEmail", "reference", "confirmationReason", "confirmedByIdentity"]) assert(!(sensitive in verifierRow));
assert.equal((await list("TOK-E")).status, 403);
assert.equal((await list("TOK-O")).status, 403);

const firstToken = sent[0].confirmationToken;
const summary = await invoke(getAuthorizationSummary, new Request(`http://127.0.0.1/api/projects/PRJ-A/authorizations/${authorizationId}/confirm`, { headers: { "X-Authorization-Capability": firstToken } }), { projectId: "PRJ-A", authorizationId });
assert.equal(summary.status, 200);
assert(!summary.text.includes(firstToken));
assert.equal(JSON.parse(summary.text).authorization.authorizerName, "Jane Approver");
db.database.prepare("UPDATE enterprise_authorizations SET confirmation_token_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(authorizationId);
const expired = await invoke(confirmAuthorization, new Request(`http://127.0.0.1/api/projects/PRJ-A/authorizations/${authorizationId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationToken: firstToken, decision: "authorized", reason: "Approved" }) }), { projectId: "PRJ-A", authorizationId });
assert.equal(expired.status, 410);

const beforeResend = db.get("SELECT confirmation_token_nonce,confirmation_token_hash FROM enterprise_authorizations WHERE id=?", authorizationId);
const sendsBeforeResend = sent.length;
const resent = await invoke(resendAuthorization, bearerRequest(`http://127.0.0.1/api/projects/PRJ-A/authorizations/${authorizationId}/resend`, "TOK-B", {}), { projectId: "PRJ-A", authorizationId });
assert.equal(resent.status, 200);
assert.equal(sent.length, sendsBeforeResend + 1);
const resendMessage = sent.at(-1);
const afterResend = db.get("SELECT confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at FROM enterprise_authorizations WHERE id=?", authorizationId);
assert.notEqual(afterResend.confirmation_token_nonce, beforeResend.confirmation_token_nonce);
assert.notEqual(afterResend.confirmation_token_hash, beforeResend.confirmation_token_hash);
assert.notEqual(resendMessage.confirmationToken, firstToken);
const oldToken = await invoke(confirmAuthorization, new Request(`http://127.0.0.1/api/projects/PRJ-A/authorizations/${authorizationId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationToken: firstToken, decision: "authorized", reason: "Approved" }) }), { projectId: "PRJ-A", authorizationId });
assert.equal(oldToken.status, 409);
const confirmed = await invoke(confirmAuthorization, new Request(`http://127.0.0.1/api/projects/PRJ-A/authorizations/${authorizationId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationToken: resendMessage.confirmationToken, decision: "authorized", reason: "Approved" }) }), { projectId: "PRJ-A", authorizationId });
assert.equal(confirmed.status, 200);
assert.equal(db.get("SELECT confirmed_by_identity FROM enterprise_authorizations WHERE id=?", authorizationId).confirmed_by_identity, "Jane Approver <jane@example.invalid>");

let providerCalls = 0;
const consumedMessage = { body: resendMessage, acked: false, ack() { this.acked = true; }, retry() {} };
await consumer.queue({ messages: [consumedMessage] }, { DB: db, NOTIFICATION_PROVIDER: { async fetch() { providerCalls += 1; return new Response("ok"); } } });
assert.equal(providerCalls, 0);
assert(consumedMessage.acked);

db.exec("UPDATE enterprise_authorizations SET status='pending',token_consumed_at=NULL,confirmation_delivery_attempts=0 WHERE id='" + authorizationId + "'");
const message = { body: resendMessage, acked: false, retried: false, ack() { this.acked = true; }, retry() { this.retried = true; } };
await consumer.queue({ messages: [message] }, { DB: db, NOTIFICATION_PROVIDER: { async fetch(_url, init) { providerCalls += 1; assert.equal(init.headers["Idempotency-Key"], resendMessage.notificationId); return new Response("ok"); } } });
assert.equal(db.get("SELECT confirmation_delivery_attempts FROM enterprise_authorizations WHERE id=?", authorizationId).confirmation_delivery_attempts, 1);
assert.equal(providerCalls, 1);
assert(message.acked);
const duplicate = { ...message, acked: false, retried: false };
await consumer.queue({ messages: [duplicate] }, { DB: db, NOTIFICATION_PROVIDER: { async fetch() { providerCalls += 1; return new Response("ok"); } } });
assert.equal(providerCalls, 1);
assert(duplicate.acked);

const secondResend = await invoke(resendAuthorization, bearerRequest(`http://127.0.0.1/api/projects/PRJ-A/authorizations/${authorizationId}/resend`, "TOK-B", {}), { projectId: "PRJ-A", authorizationId });
assert.equal(secondResend.status, 429);
assert.equal(JSON.parse(secondResend.text).code, "authorization_resend_cooldown");
db.database.prepare("UPDATE authorization_notification_outbox SET created_at='2000-01-01 00:00:00' WHERE authorization_id=?").run(authorizationId);
const afterCooldown = await invoke(resendAuthorization, bearerRequest(`http://127.0.0.1/api/projects/PRJ-A/authorizations/${authorizationId}/resend`, "TOK-B", {}), { projectId: "PRJ-A", authorizationId });
assert.equal(afterCooldown.status, 200);
const currentMessage = sent.at(-1);
const staleOld = { ...message, acked: false, retried: false };
await consumer.queue({ messages: [staleOld] }, { DB: db, NOTIFICATION_PROVIDER: { async fetch() { providerCalls += 1; return new Response("ok"); } } });
assert.equal(providerCalls, 1);
assert(staleOld.acked);

db.database.prepare("UPDATE enterprise_authorizations SET confirmation_token_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(authorizationId);
const expiredMessage = { body: currentMessage, acked: false, ack() { this.acked = true; }, retry() {} };
await consumer.queue({ messages: [expiredMessage] }, { DB: db, NOTIFICATION_PROVIDER: { async fetch() { providerCalls += 1; return new Response("ok"); } } });
assert.equal(providerCalls, 1);
assert(expiredMessage.acked);
db.database.prepare("UPDATE enterprise_authorizations SET confirmation_token_expires_at=? WHERE id=?").run(currentMessage.confirmationTokenExpiresAt, authorizationId);

const failedMessage = { body: currentMessage, acked: false, retried: false, ack() { this.acked = true; }, retry() { this.retried = true; } };
await consumer.queue({ messages: [failedMessage] }, { DB: db, NOTIFICATION_PROVIDER: { async fetch() { providerCalls += 1; return new Response("no", { status: 500 }); } } });
assert.equal(db.get("SELECT confirmation_delivery_attempts FROM enterprise_authorizations WHERE id=?", authorizationId).confirmation_delivery_attempts, 2);
assert.equal(providerCalls, 2);
assert(failedMessage.retried);
const dlqMessage = { body: currentMessage, acked: false, ack() { this.acked = true; } };
await dlq.queue({ messages: [dlqMessage] }, { DB: db });
assert.equal(db.get("SELECT confirmation_delivery_attempts FROM enterprise_authorizations WHERE id=?", authorizationId).confirmation_delivery_attempts, 2);
assert(dlqMessage.acked);

db.close();

async function verifyOutboxRecovery(interruption) {
  const recoveryDb = new D1Harness();
  recoveryDb.exec(`
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role) VALUES ('PRJ-R','Recovery','Scope','evidence','active','L2','owner');
    INSERT INTO accounts(id,email,name,status) VALUES ('BLD-R','r@example.invalid','Builder','active');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('PRJ-R','BLD-R','external_builder','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-R','BLD-R','PRJ-R','2099-01-01T00:00:00Z','REF-R');
  `);
  const recoveryMessages = [];
  let firstSend = true;
  const recoveryEnv = {
    DB: recoveryDb,
    AUTHORIZATION_CONFIRMATION_HMAC_SECRET: "test-only-secret",
    AUTHORIZATION_CONFIRMATION_QUEUE: { async send(body) {
      if (interruption === "before-send" && firstSend) { firstSend = false; throw new Error("injected before queue send"); }
      recoveryMessages.push(structuredClone(body));
      firstSend = false;
    } },
  };
  const recoveryRequest = () => bearerRequest("http://127.0.0.1/api/projects/PRJ-R/authorizations", "TOK-R", createBody, { "Idempotency-Key": `RECOVER-${interruption}` });
  if (interruption === "after-send") recoveryDb.failSqlOncePattern = /UPDATE authorization_notification_outbox SET status='queued'/;
  const firstResponse = await createAuthorization({ request: recoveryRequest(), env: recoveryEnv, params: { projectId: "PRJ-R" } });
  assert.equal(firstResponse.status, 503);
  assert.equal(recoveryDb.count("enterprise_authorizations"), 1);
  assert.equal(recoveryDb.count("authorization_notification_outbox"), 1);
  assert.equal(recoveryDb.count("idempotency_records"), 1);
  const replayResponse = await createAuthorization({ request: recoveryRequest(), env: recoveryEnv, params: { projectId: "PRJ-R" } });
  assert.equal(replayResponse.status, 201);
  assert.equal(recoveryDb.count("enterprise_authorizations"), 1);
  assert.equal(recoveryDb.count("authorization_notification_outbox"), 1);
  assert.equal(new Set(recoveryMessages.map((entry) => entry.notificationId)).size, 1);
  assert.equal(recoveryDb.get("SELECT status FROM authorization_notification_outbox").status, "queued");
  recoveryDb.close();
}

await verifyOutboxRecovery("before-send");
await verifyOutboxRecovery("after-send");
console.log("authorization capability, access, idempotency runtime: ok");
