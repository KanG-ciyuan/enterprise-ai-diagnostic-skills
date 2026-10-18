import { actor, cors, demoActor, formalActor, httpError, itemPayload, json, requireMembership } from "../../../_shared.js";

export async function onRequest({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const formal = params.projectId.startsWith("PRJ-");
    const current = formal ? await formalActor(request, env.DB) : demoActor(request);
    const exists = await env.DB.prepare("SELECT 1 FROM projects WHERE id = ?").bind(params.projectId).first();
    if (!exists) return httpError("项目不存在", 404);
    // formalActor + project_memberships is the server-side scope boundary.
    if (formal) await requireMembership(env.DB, params.projectId, current);
    let sql = "SELECT * FROM work_items WHERE project_id = ?";
    const binds = [params.projectId];
    if (current.role === "verifier") {
      sql += " AND stage IN ('mapping','facts','risk')";
      if (formal) { sql += " AND assigned_verifier_id = ?"; binds.push(current.accountId); }
    }
    else if (current.role === "employee") { sql += " AND assignee_role = ? AND assignee_account_id = ?"; binds.push(current.role, current.accountId || current.userId); }
    else if (current.role === "owner") return httpError("企业负责人只能审阅已发布的决策摘要", 403);
    else if (current.role === "external_builder") { sql += " AND assignee_role = 'external_builder' AND assignee_account_id = ?"; binds.push(current.accountId); }
    const result = await env.DB.prepare(sql).bind(...binds).all();
    return json({ items: (result.results || []).map(itemPayload) });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
