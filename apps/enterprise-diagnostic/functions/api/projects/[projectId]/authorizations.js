import { authorizationConfirmationToken, cors, formalActor, httpError, idempotencyKey, json, requireMembership, sha256 } from "../../../_shared.js";

const normalizedEmail = (value) => String(value || "").trim().toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const capabilityExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

function publicAuthorization(row, role) {
  const common = { id: row.id, projectId: row.project_id, label: row.name, name: row.name, scope: row.scope, status: row.status, confirmedAt: row.confirmed_at || null, createdAt: row.created_at };
  if (role !== "external_builder") return common;
  return { ...common, authorizerName: row.authorizer_name, authorizerEmail: row.authorizer_email, reference: row.reference, deliveryStatus: row.confirmation_delivery_status, deliveryAttempts: Number(row.confirmation_delivery_attempts || 0), deliveryLastAttemptAt: row.confirmation_delivery_last_attempt_at || null, capabilityExpiresAt: row.confirmation_token_expires_at || null, confirmedByIdentity: row.confirmed_by_identity || null, confirmationReason: row.confirmation_reason || null };
}

async function creationReplay(db, accountId, projectId, key) {
  const row = await db.prepare("SELECT response_json FROM idempotency_records WHERE account_id=? AND project_id=? AND action='authorization-create' AND request_key=?").bind(accountId, projectId, key).first();
  if (!row) return null;
  try { return JSON.parse(row.response_json); } catch (_error) { return null; }
}

async function dispatchAuthorization(request, env, current, projectId, key, authorizationId) {
  const row = await env.DB.prepare("SELECT a.*,o.notification_id,o.token_hash AS outbox_token_hash,o.status AS outbox_status FROM enterprise_authorizations a JOIN authorization_notification_outbox o ON o.authorization_id=a.id AND o.project_id=a.project_id AND o.token_hash=a.confirmation_token_hash WHERE a.id=? AND a.project_id=? AND a.created_by_account_id=? AND a.creation_idempotency_key=?").bind(authorizationId, projectId, current.accountId, key).first();
  if (!row) return { httpStatus: 409, body: { code: "authorization_delivery_conflict", detail: "授权投递状态已变更" } };
  if (["queued", "delivered"].includes(row.outbox_status)) return creationReplay(env.DB, current.accountId, projectId, key);
  if (row.status !== "pending" || row.token_consumed_at || !row.confirmation_token_expires_at || new Date(row.confirmation_token_expires_at) <= new Date()) return { httpStatus: 409, body: { code: "authorization_delivery_conflict", detail: "授权 capability 已失效" } };
  await env.DB.prepare("UPDATE authorization_notification_outbox SET status='dispatching',dispatch_attempts=dispatch_attempts+1,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE notification_id=? AND token_hash=? AND status IN ('pending','failed','dispatching')").bind(row.notification_id, row.outbox_token_hash).run();
  const confirmationToken = await authorizationConfirmationToken(env.AUTHORIZATION_CONFIRMATION_HMAC_SECRET, projectId, row.id, row.confirmation_token_nonce, row.confirmation_token_expires_at);
  const confirmationUrl = `${new URL(request.url).origin}/authorization-confirmation.html#capability=${encodeURIComponent(confirmationToken)}&projectId=${encodeURIComponent(projectId)}&authorizationId=${encodeURIComponent(row.id)}`;
  try {
    await env.AUTHORIZATION_CONFIRMATION_QUEUE.send({ notificationId: row.notification_id, providerIdempotencyKey: row.notification_id, authorizationId: row.id, projectId, authorizationName: row.name, authorizerName: row.authorizer_name, recipientEmail: row.authorizer_email, confirmationUrl, confirmationToken, confirmationTokenHash: row.confirmation_token_hash, confirmationTokenExpiresAt: row.confirmation_token_expires_at });
    const queuedRow = { ...row, confirmation_delivery_status: "queued" };
    const success = { authorization: publicAuthorization(queuedRow, current.role) };
    const successRecord = JSON.stringify({ httpStatus: 201, body: success });
    await env.DB.batch([
      env.DB.prepare("UPDATE authorization_notification_outbox SET status='queued',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE notification_id=? AND token_hash=? AND status='dispatching'").bind(row.notification_id, row.outbox_token_hash),
      env.DB.prepare("UPDATE enterprise_authorizations SET confirmation_delivery_status='queued',confirmation_delivery_last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=? AND confirmation_token_hash=? AND status='pending' AND token_consumed_at IS NULL").bind(row.id, projectId, row.outbox_token_hash),
      env.DB.prepare("UPDATE idempotency_records SET response_json=? WHERE account_id=? AND project_id=? AND action='authorization-create' AND request_key=?").bind(successRecord, current.accountId, projectId, key),
      env.DB.prepare("INSERT OR IGNORE INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?)").bind(`EVT-AUTH-QUEUED-${row.id}-${row.notification_id}`, projectId, "authorization_queued", "external_builder", current.accountId, JSON.stringify({ authorizationId: row.id, notificationId: row.notification_id, status: "queued" })),
    ]);
    return { httpStatus: 201, body: success };
  } catch (_deliveryError) {
    const failedRow = { ...row, confirmation_delivery_status: "failed" };
    const failure = { code: "authorization_delivery_failed", authorization: publicAuthorization(failedRow, current.role), detail: "授权 capability 已安全保存，重放同一请求可恢复投递。" };
    const failureRecord = JSON.stringify({ httpStatus: 503, body: failure });
    await env.DB.batch([
      env.DB.prepare("UPDATE authorization_notification_outbox SET status='failed',last_error='queue_dispatch_interrupted',updated_at=CURRENT_TIMESTAMP WHERE notification_id=? AND token_hash=?").bind(row.notification_id, row.outbox_token_hash),
      env.DB.prepare("UPDATE enterprise_authorizations SET confirmation_delivery_status='failed',confirmation_delivery_last_error='confirmation_queue_send_failed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=? AND confirmation_token_hash=?").bind(row.id, projectId, row.outbox_token_hash),
      env.DB.prepare("UPDATE idempotency_records SET response_json=? WHERE account_id=? AND project_id=? AND action='authorization-create' AND request_key=?").bind(failureRecord, current.accountId, projectId, key),
    ]);
    return { httpStatus: 503, body: failure };
  }
}

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder", "verifier"]);
    const result = await env.DB.prepare("SELECT * FROM enterprise_authorizations WHERE project_id=? ORDER BY created_at DESC").bind(params.projectId).all();
    return json({ authorizations: (result.results || []).map((row) => publicAuthorization(row, current.role)) });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder"]);
    if (current.role !== "external_builder") return httpError("只有外部建设方可以登记企业授权记录", 403);
    const key = idempotencyKey(request).trim();
    if (!key) return httpError("登记企业授权需要 Idempotency-Key", 422);
    const replay = await creationReplay(env.DB, current.accountId, params.projectId, key);
    if (replay) {
      const authorizationId = replay.body?.authorization?.id;
      if (authorizationId && ["pending", "failed"].includes(replay.body.authorization.deliveryStatus)) {
        const recovered = await dispatchAuthorization(request, env, current, params.projectId, key, authorizationId);
        return json(recovered.body, recovered.httpStatus);
      }
      return json(replay.body, replay.httpStatus);
    }
    const body = await request.json().catch(() => ({}));
    const label = String(body.label || body.name || "").trim();
    const authorizerName = String(body.authorizerName || "").trim();
    const authorizerEmail = normalizedEmail(body.authorizerEmail);
    const scope = String(body.scope || "").trim();
    const reference = String(body.reference || "").trim();
    if (!label || !authorizerName || !validEmail(authorizerEmail) || !scope || !reference) return httpError("授权标签、具名确认人、邮箱、范围或外部记录引用无效", 422);
    const deliveryConfigured = Boolean(env.AUTHORIZATION_CONFIRMATION_QUEUE?.send) && Boolean(env.AUTHORIZATION_CONFIRMATION_HMAC_SECRET);
    const id = `AUTH-${crypto.randomUUID()}`;
    const notificationId = `AUTHNOT-${crypto.randomUUID()}`;
    const confirmationTokenNonce = crypto.randomUUID();
    const confirmationTokenExpiresAt = capabilityExpiry();
    // When the delivery channel is configured we sign the capability with the HMAC
    // secret. Without it (manual handoff mode) we fall back to a random capability
    // so the confirmation can still be completed by handing the link to the person.
    const confirmationToken = deliveryConfigured
      ? await authorizationConfirmationToken(env.AUTHORIZATION_CONFIRMATION_HMAC_SECRET, params.projectId, id, confirmationTokenNonce, confirmationTokenExpiresAt)
      : `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const confirmationTokenHash = await sha256(confirmationToken);
    const created = { id, project_id: params.projectId, name: label, authorizer_name: authorizerName, authorizer_email: authorizerEmail, scope, reference, status: "pending", confirmation_delivery_status: "pending", confirmation_delivery_attempts: 0, confirmation_token_expires_at: confirmationTokenExpiresAt, confirmed_at: null, created_at: new Date().toISOString() };
    const pending = { authorization: publicAuthorization(created, current.role) };
    const pendingRecord = JSON.stringify({ httpStatus: 202, body: pending });
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at,confirmation_delivery_status) VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?,?,'pending')").bind(id, params.projectId, label, authorizerName, authorizerEmail, scope, reference, current.accountId, key, confirmationTokenNonce, confirmationTokenHash, confirmationTokenExpiresAt),
        env.DB.prepare("INSERT INTO authorization_notification_outbox(notification_id,authorization_id,project_id,token_hash,status) SELECT ?,id,project_id,confirmation_token_hash,'pending' FROM enterprise_authorizations WHERE id=? AND project_id=? AND creation_idempotency_key=?").bind(notificationId, id, params.projectId, key),
        env.DB.prepare("INSERT INTO idempotency_records(account_id,project_id,action,request_key,response_json) SELECT ?,?,'authorization-create',?,? FROM enterprise_authorizations WHERE id=? AND project_id=? AND creation_idempotency_key=?").bind(current.accountId, params.projectId, key, pendingRecord, id, params.projectId, key),
        env.DB.prepare("INSERT OR IGNORE INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?)").bind(`EVT-AUTH-REQUESTED-${id}`, params.projectId, "authorization_requested", "external_builder", current.accountId, JSON.stringify({ authorizationId: id, status: "pending" })),
      ]);
    } catch (_conflict) {
      const concurrent = await creationReplay(env.DB, current.accountId, params.projectId, key);
      if (concurrent) {
        const authorizationId = concurrent.body?.authorization?.id;
        if (authorizationId && ["pending", "failed"].includes(concurrent.body.authorization.deliveryStatus)) {
          const recovered = await dispatchAuthorization(request, env, current, params.projectId, key, authorizationId);
          return json(recovered.body, recovered.httpStatus);
        }
        return json(concurrent.body, concurrent.httpStatus);
      }
      return json({ code: "authorization_creation_conflict", detail: "授权登记已由其他请求处理" }, 409);
    }
    if (!deliveryConfigured) {
      // Manual handoff: no email provider is bound, so hand the confirmation link to
      // the builder to deliver out-of-band. The flow stays usable without email.
      const confirmationUrl = `${new URL(request.url).origin}/authorization-confirmation.html#capability=${encodeURIComponent(confirmationToken)}&projectId=${encodeURIComponent(params.projectId)}&authorizationId=${encodeURIComponent(id)}`;
      const manualRow = { ...created, confirmation_delivery_status: "manual" };
      const manualBody = { code: "authorization_manual_handoff", authorization: publicAuthorization(manualRow, current.role), confirmationUrl, warning: "未配置企业授权确认投递通道：请把上面的确认链接人工转交给企业确认人，由其打开并选择“授权/拒绝”。这不是发送真实邮件。" };
      const manualRecord = JSON.stringify({ httpStatus: 201, body: manualBody });
      await env.DB.batch([
        env.DB.prepare("UPDATE authorization_notification_outbox SET status='manual',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE notification_id=? AND token_hash=?").bind(notificationId, confirmationTokenHash),
        env.DB.prepare("UPDATE enterprise_authorizations SET confirmation_delivery_status='manual',confirmation_delivery_last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=? AND confirmation_token_hash=? AND status='pending' AND token_consumed_at IS NULL").bind(id, params.projectId, confirmationTokenHash),
        env.DB.prepare("UPDATE idempotency_records SET response_json=? WHERE account_id=? AND project_id=? AND action='authorization-create' AND request_key=?").bind(manualRecord, current.accountId, params.projectId, key),
        env.DB.prepare("INSERT OR IGNORE INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?)").bind(`EVT-AUTH-MANUAL-${id}`, params.projectId, "authorization_manual_handoff", "external_builder", current.accountId, JSON.stringify({ authorizationId: id, notificationId, status: "manual" })),
      ]);
      return json(manualBody, 201);
    }
    const dispatched = await dispatchAuthorization(request, env, current, params.projectId, key, id);
    return json(dispatched.body, dispatched.httpStatus);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
