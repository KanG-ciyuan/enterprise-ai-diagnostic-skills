import { cors, formalActor, httpError, json, requireAuthorizedProject, requireMembership } from "../../../_shared.js";

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    if (!params.projectId.startsWith("PRJ-")) return httpError("具名重新分配只支持正式项目", 401);
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    const result = await env.DB.prepare("SELECT pm.account_id,a.name FROM project_memberships pm JOIN accounts a ON a.id=pm.account_id WHERE pm.project_id=? AND pm.role='verifier' AND pm.status='active' AND a.status='active' ORDER BY lower(a.name),pm.account_id")
      .bind(params.projectId).all();
    return json({
      candidates: (result.results || []).map((entry) => ({ accountId: entry.account_id, name: entry.name || "未命名核验人" })),
    });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
