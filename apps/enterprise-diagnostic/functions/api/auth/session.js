import { cors, formalActor, httpError, json } from "../../_shared.js";

export async function onRequestGet({ request, env }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    const session = await env.DB.prepare("SELECT revoked_at,expires_at FROM sessions WHERE token=?").bind(current.token).first();
    if (!session || session.revoked_at) return httpError("会话已撤销，请重新登录。", 401);
    if (new Date(session.expires_at) <= new Date()) return httpError("会话已过期，请重新登录。", 401);
    const account = await env.DB.prepare("SELECT a.id,a.email,a.name,a.enterprise_id,a.status,e.name AS enterprise_name FROM accounts a LEFT JOIN enterprises e ON e.id=a.enterprise_id WHERE a.id=?").bind(current.accountId).first();
    if (!account || account.status !== "active") return httpError("会话账户已失效，请重新登录。", 401);
    const memberships = !current.projectId && current.accountRole !== "external_builder"
      ? (await env.DB.prepare("SELECT m.project_id,m.role,p.name,p.scope,p.status FROM project_memberships m JOIN projects p ON p.id=m.project_id WHERE m.account_id=? AND m.status='active' AND p.status='active' ORDER BY m.project_id").bind(current.accountId).all()).results || []
      : [];
    return json({ account: { id: account.id, email: account.email, name: account.name, enterpriseId: account.enterprise_id }, enterprise: account.enterprise_id ? { id: account.enterprise_id, name: account.enterprise_name || "" } : null, accountRole: current.accountRole, memberships: memberships.map(row => ({ projectId: row.project_id, role: row.role, project: { id: row.project_id, name: row.name, scope: row.scope, status: row.status } })), accountId: current.accountId, projectId: current.projectId, role: current.role, expiresAt: current.expiresAt });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
