function validMessage(body) {
  return body && body.notificationId && body.providerIdempotencyKey === body.notificationId && body.authorizationId && body.projectId && body.authorizationName && body.authorizerName && body.recipientEmail && body.confirmationUrl && body.confirmationToken && body.confirmationTokenHash && body.confirmationTokenExpiresAt;
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = message.body;
      if (!validMessage(body) || !env.DB) {
        message.ack();
        continue;
      }
      const current = await env.DB.prepare("SELECT a.status AS authorization_status,a.token_consumed_at,a.confirmation_token_hash,a.confirmation_token_expires_at,o.status AS outbox_status,o.token_hash AS outbox_token_hash FROM enterprise_authorizations a JOIN authorization_notification_outbox o ON o.authorization_id=a.id AND o.project_id=a.project_id WHERE a.id=? AND a.project_id=? AND o.notification_id=?").bind(body.authorizationId, body.projectId, body.notificationId).first();
      const suppliedHash = await sha256(body.confirmationToken);
      const stale = !current || current.authorization_status !== "pending" || current.token_consumed_at || current.confirmation_token_hash !== body.confirmationTokenHash || current.outbox_token_hash !== body.confirmationTokenHash || suppliedHash !== body.confirmationTokenHash || !current.confirmation_token_expires_at || current.confirmation_token_expires_at !== body.confirmationTokenExpiresAt || new Date(current.confirmation_token_expires_at) <= new Date() || ["delivered", "superseded", "failed_terminal"].includes(current.outbox_status);
      if (stale) {
        message.ack();
        continue;
      }
      if (!env.NOTIFICATION_PROVIDER?.fetch) {
        await env.DB.batch([
          env.DB.prepare("UPDATE authorization_notification_outbox SET status='failed_terminal',last_error='notification_provider_binding_missing',updated_at=CURRENT_TIMESTAMP WHERE notification_id=? AND token_hash=?").bind(body.notificationId, body.confirmationTokenHash),
          env.DB.prepare("UPDATE enterprise_authorizations SET confirmation_delivery_status='failed_terminal',confirmation_delivery_last_error='notification_provider_binding_missing',confirmation_delivery_last_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=?").bind(body.authorizationId, body.projectId),
          env.DB.prepare("INSERT OR IGNORE INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?)").bind(`EVT-AUTH-FAILED-${body.notificationId}`, body.projectId, "authorization_delivery_failed", "system", "authorization-confirmation-consumer", JSON.stringify({ authorizationId: body.authorizationId, notificationId: body.notificationId, reason: "provider_binding_missing" })),
        ]);
        message.ack();
        continue;
      }
      try {
        await env.DB.prepare("UPDATE enterprise_authorizations SET confirmation_delivery_attempts=confirmation_delivery_attempts+1,confirmation_delivery_last_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=? AND status='pending' AND token_consumed_at IS NULL").bind(body.authorizationId, body.projectId).run();
        const response = await env.NOTIFICATION_PROVIDER.fetch("https://notification-provider.internal/authorization-confirmation", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": body.providerIdempotencyKey },
          body: JSON.stringify({ template: "enterprise-authorization-confirmation", providerIdempotencyKey: body.providerIdempotencyKey, recipientEmail: body.recipientEmail, authorizationName: body.authorizationName, authorizerName: body.authorizerName, confirmationUrl: body.confirmationUrl, confirmationToken: body.confirmationToken, confirmationTokenExpiresAt: body.confirmationTokenExpiresAt }),
        });
        if (!response.ok) throw new Error("notification_provider_rejected");
        await env.DB.batch([
          env.DB.prepare("UPDATE authorization_notification_outbox SET status='delivered',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE notification_id=? AND token_hash=? AND status NOT IN ('superseded','failed_terminal')").bind(body.notificationId, body.confirmationTokenHash),
          env.DB.prepare("UPDATE enterprise_authorizations SET confirmation_delivery_status='delivered',confirmation_delivery_last_error=NULL,confirmation_delivery_last_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=? AND status='pending' AND token_consumed_at IS NULL AND confirmation_token_hash=?").bind(body.authorizationId, body.projectId, body.confirmationTokenHash),
          env.DB.prepare("INSERT OR IGNORE INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?)").bind(`EVT-AUTH-DELIVERED-${body.notificationId}`, body.projectId, "authorization_delivered", "system", "authorization-confirmation-consumer", JSON.stringify({ authorizationId: body.authorizationId, notificationId: body.notificationId, status: "delivered" })),
        ]);
        message.ack();
      } catch (_error) {
        await env.DB.batch([
          env.DB.prepare("UPDATE authorization_notification_outbox SET status='provider_retrying',last_error='notification_provider_delivery_failed',updated_at=CURRENT_TIMESTAMP WHERE notification_id=? AND token_hash=? AND status NOT IN ('superseded','failed_terminal')").bind(body.notificationId, body.confirmationTokenHash),
          env.DB.prepare("UPDATE enterprise_authorizations SET confirmation_delivery_status='provider_retrying',confirmation_delivery_last_error='notification_provider_delivery_failed',confirmation_delivery_last_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=? AND status='pending' AND token_consumed_at IS NULL AND confirmation_token_hash=?").bind(body.authorizationId, body.projectId, body.confirmationTokenHash),
          env.DB.prepare("INSERT OR IGNORE INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?)").bind(`EVT-AUTH-RETRY-${body.notificationId}-${Date.now()}`, body.projectId, "authorization_delivery_retrying", "system", "authorization-confirmation-consumer", JSON.stringify({ authorizationId: body.authorizationId, notificationId: body.notificationId, status: "provider_retrying" })),
        ]);
        message.retry();
      }
    }
  },
};
