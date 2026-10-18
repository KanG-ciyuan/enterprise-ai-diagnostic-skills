import { authorizationConfirmationToken, authorizationDeliveryConfigError, cors, formalActor, httpError, json, requireMembership, sha256 } from "../../../../../_shared.js";

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder"]);
    if (current.role !== "external_builder") return httpError("只有外部建设方可以重试授权投递", 403);
    if (!env.AUTHORIZATION_CONFIRMATION_QUEUE?.send || !env.AUTHORIZATION_CONFIRMATION_HMAC_SECRET) return httpError(authorizationDeliveryConfigError(env), 503);
    const authorization = await env.DB.prepare("SELECT * FROM enterprise_authorizations WHERE id=? AND project_id=? AND status='pending' AND token_consumed_at IS NULL")
      .bind(params.authorizationId, params.projectId).first();
    if (!authorization) return httpError("授权记录不存在、已确认或 token 已消费", 409);
    if (!authorization.authorizer_name || !authorization.authorizer_email) return httpError("旧版授权记录缺少具名确认人，必须重新创建授权", 409);
    const confirmationTokenNonce = crypto.randomUUID();
    const notificationId = `AUTHNOT-${crypto.randomUUID()}`;
    const confirmationTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const confirmationToken = await authorizationConfirmationToken(env.AUTHORIZATION_CONFIRMATION_HMAC_SECRET, params.projectId, authorization.id, confirmationTokenNonce, confirmationTokenExpiresAt);
    const confirmationTokenHash = await sha256(confirmationToken);
    const now = new Date().toISOString();
    const recentResend = await env.DB.prepare("SELECT COUNT(*) AS count FROM authorization_notification_outbox WHERE authorization_id=? AND created_at>datetime('now','-5 minutes')").bind(authorization.id).first();
    const dailyResends = await env.DB.prepare("SELECT COUNT(*) AS count FROM authorization_notification_outbox WHERE authorization_id=? AND created_at>datetime('now','-24 hours')").bind(authorization.id).first();
    if (Number(dailyResends?.count || 0) >= 4) return httpError("24 小时内最多重发 3 次，请稍后再试", 429, "authorization_resend_daily_limit");
    if (Number(recentResend?.count || 0) > 0 && authorization.confirmation_delivery_status !== "failed_terminal" && authorization.confirmation_token_expires_at && new Date(authorization.confirmation_token_expires_at) > new Date()) return httpError("授权确认链接 5 分钟内只能重发一次，请稍后再试", 429, "authorization_resend_cooldown");
    const rotated = await env.DB.batch([
      env.DB.prepare("UPDATE enterprise_authorizations SET confirmation_token_nonce=?,confirmation_token_hash=?,confirmation_token_expires_at=?,confirmation_delivery_status='pending',updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=? AND status='pending' AND token_consumed_at IS NULL AND confirmation_token_hash=?").bind(confirmationTokenNonce, confirmationTokenHash, confirmationTokenExpiresAt, authorization.id, params.projectId, authorization.confirmation_token_hash),
      env.DB.prepare("UPDATE authorization_notification_outbox SET status='superseded',updated_at=CURRENT_TIMESTAMP WHERE authorization_id=? AND project_id=? AND token_hash=? AND EXISTS (SELECT 1 FROM enterprise_authorizations WHERE id=? AND project_id=? AND confirmation_token_hash=?)").bind(authorization.id, params.projectId, authorization.confirmation_token_hash, authorization.id, params.projectId, confirmationTokenHash),
      env.DB.prepare("INSERT INTO authorization_notification_outbox(notification_id,authorization_id,project_id,token_hash,status) SELECT ?,id,project_id,confirmation_token_hash,'dispatching' FROM enterprise_authorizations WHERE id=? AND project_id=? AND confirmation_token_hash=?").bind(notificationId, authorization.id, params.projectId, confirmationTokenHash),
    ]);
    if (!Number(rotated[0]?.meta?.changes || 0)) {
      const latest = await env.DB.prepare("SELECT status,token_consumed_at FROM enterprise_authorizations WHERE id=? AND project_id=?").bind(authorization.id, params.projectId).first();
      if (!latest || latest.status !== "pending" || latest.token_consumed_at) return httpError("授权记录不存在、已确认或 token 已消费", 409);
      return httpError("授权确认链接状态已变化，请刷新后重试", 409);
    }
    const confirmationUrl = `${new URL(request.url).origin}/authorization-confirmation.html#capability=${encodeURIComponent(confirmationToken)}&projectId=${encodeURIComponent(params.projectId)}&authorizationId=${encodeURIComponent(authorization.id)}`;
    try {
      await env.AUTHORIZATION_CONFIRMATION_QUEUE.send({ notificationId, providerIdempotencyKey: notificationId, authorizationId: authorization.id, projectId: params.projectId, authorizationName: authorization.name, authorizerName: authorization.authorizer_name, recipientEmail: authorization.authorizer_email, confirmationUrl, confirmationToken, confirmationTokenHash, confirmationTokenExpiresAt });
      await env.DB.batch([
        env.DB.prepare("UPDATE authorization_notification_outbox SET status='queued',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE notification_id=? AND token_hash=?").bind(notificationId, confirmationTokenHash),
        env.DB.prepare("UPDATE enterprise_authorizations SET confirmation_delivery_status='queued',confirmation_delivery_last_error=NULL,confirmation_delivery_last_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=? AND status='pending' AND token_consumed_at IS NULL AND confirmation_token_hash=?").bind(authorization.id, params.projectId, confirmationTokenHash),
        env.DB.prepare("INSERT OR IGNORE INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?)").bind(`EVT-AUTH-RESENT-${authorization.id}-${notificationId}`, params.projectId, "authorization_resent", "external_builder", current.accountId, JSON.stringify({ authorizationId: authorization.id, notificationId, status: "queued" })),
      ]);
      return json({ authorizationId: authorization.id, deliveryStatus: "queued", deliveryAttempts: Number(authorization.confirmation_delivery_attempts || 0), capabilityExpiresAt: confirmationTokenExpiresAt });
    } catch (_deliveryError) {
      await env.DB.batch([
        env.DB.prepare("UPDATE authorization_notification_outbox SET status='failed',last_error='confirmation_queue_send_failed',updated_at=CURRENT_TIMESTAMP WHERE notification_id=? AND token_hash=?").bind(notificationId, confirmationTokenHash),
        env.DB.prepare("UPDATE enterprise_authorizations SET confirmation_delivery_status='failed',confirmation_delivery_last_error='confirmation_queue_send_failed',confirmation_delivery_last_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=? AND status='pending' AND token_consumed_at IS NULL AND confirmation_token_hash=?").bind(authorization.id, params.projectId, confirmationTokenHash),
      ]);
      return json({ code: "authorization_delivery_failed", authorizationId: authorization.id, detail: "授权投递仍未成功，可稍后再次重试。" }, 503);
    }
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
