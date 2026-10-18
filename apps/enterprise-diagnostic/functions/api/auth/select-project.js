import { cors, formalActor, httpError, json } from "../../_shared.js";

export async function onRequestPost({ request, env }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    const body = await request.json().catch(() => ({}));
    const projectId = String(body.projectId || "").trim();
    const membership = await env.DB.prepare("SELECT m.role,p.id,p.name,p.scope,p.status FROM project_memberships m JOIN projects p ON p.id=m.project_id WHERE m.account_id=? AND m.project_id=? AND m.status='active' AND p.status='active'").bind(current.accountId, projectId).first();
    if (!membership) return httpError("你没有权限进入该项目，或项目当前未开放。", 403);
    const updated = await env.DB.prepare("UPDATE sessions SET project_id=? WHERE token=? AND revoked_at IS NULL AND expires_at>datetime('now')").bind(projectId, current.token).run();
    if (Number(updated?.meta?.changes || 0) !== 1) return httpError("登录会话已失效，请重新验证。", 401);
    return json({ projectId, role: membership.role, project: { id: membership.id, name: membership.name, scope: membership.scope, status: membership.status } });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
