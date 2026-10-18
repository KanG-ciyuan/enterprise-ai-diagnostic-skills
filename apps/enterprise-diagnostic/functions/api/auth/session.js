import { cors, formalActor, httpError, json } from "../../_shared.js";

export async function onRequestGet({ request, env }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    const session = await env.DB.prepare("SELECT revoked_at,expires_at FROM sessions WHERE token=?").bind(current.token).first();
    if (!session || session.revoked_at) return httpError("会话已撤销，请重新登录。", 401);
    if (new Date(session.expires_at) <= new Date()) return httpError("会话已过期，请重新登录。", 401);
    const account = await env.DB.prepare("SELECT id,email,name,enterprise_id,status FROM accounts WHERE id=?").bind(current.accountId).first();
    if (!account || account.status !== "active") return httpError("会话账户已失效，请重新登录。", 401);
    return json({ account: { id: account.id, email: account.email, name: account.name, enterpriseId: account.enterprise_id }, accountId: current.accountId, projectId: current.projectId, role: current.role, expiresAt: current.expiresAt });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
