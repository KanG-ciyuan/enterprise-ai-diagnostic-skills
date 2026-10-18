export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = message.body || {};
      if (body.authorizationId && body.projectId) {
        await env.DB.batch([
          env.DB.prepare("UPDATE authorization_notification_outbox SET status='failed_terminal',last_error='queue_retries_exhausted',updated_at=CURRENT_TIMESTAMP WHERE notification_id=? AND authorization_id=? AND project_id=? AND status!='delivered'").bind(body.notificationId || "", body.authorizationId, body.projectId),
          env.DB.prepare("UPDATE enterprise_authorizations SET confirmation_delivery_status='failed_terminal',confirmation_delivery_last_error='queue_retries_exhausted',confirmation_delivery_last_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=? AND token_consumed_at IS NULL").bind(body.authorizationId, body.projectId),
        ]);
      }
      message.ack();
    }
  },
};
