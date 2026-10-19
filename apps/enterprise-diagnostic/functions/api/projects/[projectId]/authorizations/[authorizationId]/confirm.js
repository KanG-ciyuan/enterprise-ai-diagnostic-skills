import { appendEvent, cors, assertSchemaReady, httpError, json, sha256 } from "../../../../../_shared.js";

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    await assertSchemaReady(env.DB);
    const capability = String(request.headers.get("X-Authorization-Capability") || "").trim();
    if (!capability) return httpError("确认链接无效或已失效", 401);
    const hash = await sha256(capability);
    const row = await env.DB.prepare("SELECT a.id,a.project_id,a.name,a.scope,a.reference,a.authorizer_name,a.confirmation_token_expires_at,a.confirmation_delivery_status,p.name AS project_name FROM enterprise_authorizations a JOIN projects p ON p.id=a.project_id WHERE a.id=? AND a.project_id=? AND a.confirmation_token_hash=? AND a.status='pending' AND a.token_consumed_at IS NULL").bind(params.authorizationId, params.projectId, hash).first();
    if (!row) return httpError("授权记录不存在、已确认或确认链接无效", 409);
    if (!row.confirmation_token_expires_at || new Date(row.confirmation_token_expires_at) <= new Date()) return httpError("企业授权确认凭证已过期", 410);
    return new Response(JSON.stringify({ authorization: { id: row.id, projectId: row.project_id, projectName: row.project_name, name: row.name, scope: row.scope, reference: row.reference, authorizerName: row.authorizer_name, expiresAt: row.confirmation_token_expires_at, deliveryStatus: row.confirmation_delivery_status } }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    await assertSchemaReady(env.DB);
    const body = await request.json().catch(() => ({}));
    const confirmationToken = String(body.confirmationToken || "").trim();
    if (!confirmationToken) return httpError("企业授权确认凭证无效", 401);
    const confirmationTokenHash = await sha256(confirmationToken);
    const registered = await env.DB.prepare("SELECT name,authorizer_name,authorizer_email,confirmation_token_expires_at FROM enterprise_authorizations WHERE id=? AND project_id=? AND status='pending' AND token_consumed_at IS NULL AND confirmation_token_hash=?")
      .bind(params.authorizationId, params.projectId, confirmationTokenHash).first();
    if (!registered) return httpError("授权记录不存在、已确认或凭证无效", 409);
    if (!registered.authorizer_name || !registered.authorizer_email) return httpError("旧版授权缺少具名确认人，必须重新发起", 409);
    if (!registered.confirmation_token_expires_at || new Date(registered.confirmation_token_expires_at) <= new Date()) return httpError("企业授权确认凭证已过期", 410);
    const confirmerIdentity = `${registered.authorizer_name} <${registered.authorizer_email}>`;
    const decision = body.decision === "authorized" ? "authorized" : body.decision === "denied" ? "denied" : "";
    const confirmationReason = String(body.reason || "").trim();
    if (!decision || !confirmationReason) return httpError("授权确认必须包含决定和理由", 422);
    const currentIso = new Date().toISOString();
    const result = await env.DB.batch([
      env.DB.prepare("UPDATE enterprise_authorizations SET status=?,confirmed_by_identity=?,confirmed_at=?,confirmation_reason=?,token_consumed_at=?,confirmation_delivery_status='consumed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=? AND status='pending' AND token_consumed_at IS NULL AND confirmation_token_hash=? AND datetime(confirmation_token_expires_at)>datetime(?)")
        .bind(decision, confirmerIdentity, currentIso, confirmationReason, currentIso, params.authorizationId, params.projectId, confirmationTokenHash, currentIso),
      env.DB.prepare("UPDATE evidence_materials SET authorization_status=(SELECT status FROM enterprise_authorizations WHERE id=? AND project_id=?) WHERE authorization_record_id=? AND project_id=? AND authorization_status='pending' AND EXISTS (SELECT 1 FROM enterprise_authorizations WHERE id=? AND project_id=? AND status!='pending')")
        .bind(params.authorizationId, params.projectId, params.authorizationId, params.projectId, params.authorizationId, params.projectId),
      env.DB.prepare("UPDATE projects SET authorization_stage='authorized',status='active' WHERE id=? AND ?='authorized' AND EXISTS (SELECT 1 FROM enterprise_authorizations WHERE id=? AND project_id=? AND status='authorized' AND confirmation_token_hash=? AND token_consumed_at=?)")
        .bind(params.projectId, decision, params.authorizationId, params.projectId, confirmationTokenHash, currentIso),
      env.DB.prepare("INSERT INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?)").bind(`EVT-AUTH-${decision}-${params.authorizationId}-${currentIso}`, params.projectId, decision === "authorized" ? "authorization_confirmed" : "authorization_denied", "enterprise_authorizer", registered.authorizer_email, JSON.stringify({ authorizationId: params.authorizationId, decision, reason: confirmationReason })),
    ]);
    if (!Number(result[0]?.meta?.changes || 0)) return httpError("授权记录不存在或已经确认", 409);
    const authorization = await env.DB.prepare("SELECT id,project_id,name,authorizer_name,scope,reference,status,confirmed_by_identity,confirmed_at,confirmation_reason FROM enterprise_authorizations WHERE id=? AND project_id=?")
      .bind(params.authorizationId, params.projectId).first();
    return json({ authorization });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
