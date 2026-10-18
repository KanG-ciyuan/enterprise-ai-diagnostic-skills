// Isolated acceptance provider. It intentionally accepts only .invalid recipients.
export default {
  async fetch(request, env) {
    if (env.FORMAL_AUTH_TEST_MODE !== "1") return new Response("Not Found", { status: 404 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await request.json().catch(() => null);
    const recipient = String(body?.recipientEmail || "").trim().toLowerCase();
    if (!recipient.endsWith(".invalid")) return new Response("isolated provider only accepts .invalid", { status: 400 });
    if (!env.DB) return new Response("test inbox unavailable", { status: 503 });
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS authorization_test_inbox (notification_id TEXT PRIMARY KEY, authorization_id TEXT NOT NULL, project_id TEXT NOT NULL, recipient_email TEXT NOT NULL, confirmation_url TEXT NOT NULL, confirmation_token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'delivered', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    await env.DB.prepare("INSERT OR REPLACE INTO authorization_test_inbox(notification_id,authorization_id,project_id,recipient_email,confirmation_url,confirmation_token,status) VALUES (?,?,?,?,?,?, 'delivered')").bind(body.notificationId || body.providerIdempotencyKey, body.authorizationId, body.projectId, recipient, body.confirmationUrl, body.confirmationToken).run();
    return new Response(JSON.stringify({ delivered: true }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  },
};
