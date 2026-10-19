import { PROVIDER_DELIVERED_MARKER, cors, assertSchemaReady, httpError, json, requestSessionToken, resolveAuthMode, sessionCookie, sha256, withSessionCookie } from "../../_shared.js";

function accountPayload(row) {
  return { id: row.account_id_value || row.id, email: row.email, name: row.name, enterpriseId: row.enterprise_id, status: row.account_status || row.status };
}

export async function onRequestPost({ request, env }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    await assertSchemaReady(env.DB);
    const body = await request.json().catch(() => ({}));
    const token = String(body?.token || "").trim();
    if (!token) return httpError("登录验证链接无效或已失效，请重新请求。", 401, "login_challenge_invalid");
    const tokenHash = await sha256(token);
    const challenge = await env.DB.prepare("SELECT c.id,c.account_id,c.expires_at,c.delivery_status,c.delivery_error,a.id AS account_id_value,a.email,a.name,a.enterprise_id,a.status AS account_status FROM member_login_challenges c JOIN accounts a ON a.id=c.account_id WHERE c.token_hash=?").bind(tokenHash).first();
    if (!challenge || challenge.account_status !== "active" || challenge.delivery_status !== "delivered" || new Date(challenge.expires_at) <= new Date()) return httpError("登录验证链接无效或已失效，请重新请求。", 401, "login_challenge_invalid");
    // ── B2-01 + B-1：模式感知守卫（独立于 login-request）──────────────────
    // delivery_status='delivered' 并不等于"真实邮件已投递"：开发回退分支同样把
    // challenge 标为 delivered，然后直接把链接放进 HTTP 响应体。因此这里必须
    // 独立判断凭证**来源**，不能依赖投递状态位。
    //
    // B-1 起改为**只接受正向来源标记**（既有 delivery_error 列，无需迁移）：
    //   PROVIDER_DELIVERED_MARKER ("provider_delivered") → 真实 provider 投递成功 ✔ 允许
    //   NULL                                          → 历史遗留/来源不明（旧版开发回退
    //                                                    与旧版真实投递在存储上不可区分）✘ 拒绝
    //   "dev_fallback_link"                           → 响应体内返回的开发回退凭证     ✘ 拒绝
    //   no_provider_manual_link / 未知标记            → 非成功投递                     ✘ 拒绝
    //
    // 安全取舍（已在报告中说明）：部署新代码后，**旧版未打标**的真实登录链接会失效；
    // 用户重新申请即可。历史凭证在 15 分钟内自然过期，歧义窗口永久闭合。
    //
    // 开发语义下不做来源限制，既有受控测试登录能力保持不变。
    const mode = resolveAuthMode(env);
    if (!mode.isDevelopment && challenge.delivery_error !== PROVIDER_DELIVERED_MARKER) {
      return httpError("登录验证链接无效或已失效，请重新请求。", 401, "login_challenge_invalid");
    }
    const memberships = await env.DB.prepare("SELECT m.project_id,m.role,m.scope,m.status,p.id AS project_id_value,p.name AS project_name,p.scope AS project_scope,p.status AS project_status FROM project_memberships m JOIN projects p ON p.id=m.project_id WHERE m.account_id=? AND m.status='active' AND p.status='active' ORDER BY m.project_id").bind(challenge.account_id).all();
    const activeMemberships = (memberships.results || []).map((row) => ({ projectId: row.project_id, role: row.role, scope: row.scope, status: row.status, project: { id: row.project_id_value, name: row.project_name, scope: row.project_scope, status: row.project_status } }));
    // A provisioned active account with zero project memberships may still sign in;
    // the client routes a 0-membership session to the builder workspace (create /
    // manage projects). A valid delivered challenge + active account is the credential.
    const consumedAt = new Date().toISOString();
    const consumeClaim = crypto.randomUUID();
    const tokenValue = crypto.randomUUID().replaceAll("-", "");
    const refreshToken = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    const projectId = activeMemberships.length === 1 ? activeMemberships[0].projectId : null;
    const previousSessionToken = requestSessionToken(request);
    const statements = [
      env.DB.prepare("UPDATE member_login_challenges SET consumed_at=?,consume_claim=? WHERE id=? AND consumed_at IS NULL AND consume_claim IS NULL AND delivery_status='delivered' AND datetime(expires_at)>datetime('now')").bind(consumedAt, consumeClaim, challenge.id),
    ];
    if (previousSessionToken) statements.push(env.DB.prepare("UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM member_login_challenges WHERE id=? AND consume_claim=?)").bind(previousSessionToken, challenge.id, consumeClaim));
    statements.push(env.DB.prepare("INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) SELECT ?,account_id,?,?,? FROM member_login_challenges WHERE id=? AND consume_claim=?").bind(tokenValue, projectId, expiresAt, refreshToken, challenge.id, consumeClaim));
    const results = await env.DB.batch(statements);
    const sessionResultIndex = results.length - 1;
    if (Number(results[0]?.meta?.changes || 0) !== 1 || Number(results[sessionResultIndex]?.meta?.changes || 0) !== 1) return httpError("登录验证链接无效或已失效，请重新请求。", 401, "login_challenge_invalid");
    return withSessionCookie(json({
      account: accountPayload(challenge),
      memberships: activeMemberships,
      projects: activeMemberships.map((membership) => membership.project),
      session: { expiresAt, projectId },
    }), sessionCookie(tokenValue));
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
