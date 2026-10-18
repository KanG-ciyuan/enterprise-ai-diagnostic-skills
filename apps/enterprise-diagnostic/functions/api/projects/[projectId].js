import { actor, cors, formalActor, httpError, itemPayload, json, requireMembership } from "../../_shared.js";
export async function onRequest({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const projectId = params.projectId;
    const authorization = request.headers.get("Authorization");
    let current = null;
    if (projectId.startsWith("PRJ-")) {
      current = await formalActor(request, env.DB);
      await requireMembership(env.DB, projectId, current);
    } else if (authorization) {
      await formalActor(request, env.DB);
    } else {
      actor(request);
    }
    const project = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
    if (!project) return httpError("项目不存在", 404);
    if (current?.role !== "external_builder") return json({ project, role: current?.role || null });
    const [membersResult, authorizationsResult, tasksResult, latestEvent] = await Promise.all([
      env.DB.prepare("SELECT m.account_id,m.role,m.scope,m.status,m.created_at,a.name,a.email FROM project_memberships m JOIN accounts a ON a.id=m.account_id WHERE m.project_id=? ORDER BY m.created_at").bind(projectId).all(),
      env.DB.prepare("SELECT id,name,authorizer_name,authorizer_email,scope,status,confirmation_delivery_status,updated_at FROM enterprise_authorizations WHERE project_id=? ORDER BY updated_at DESC").bind(projectId).all(),
      env.DB.prepare("SELECT wi.*,verifier.name AS assigned_verifier_name FROM work_items wi LEFT JOIN accounts verifier ON verifier.id=wi.assigned_verifier_id WHERE wi.project_id=? ORDER BY CASE wi.status WHEN 'revision_requested' THEN 0 WHEN 'blocked' THEN 1 WHEN 'awaiting_verification' THEN 2 WHEN 'needs_input' THEN 3 ELSE 4 END,wi.id DESC").bind(projectId).all(),
      // PILOT-09A-FIX2B/R2：最近业务事件不得是内部模型调用计量事件（model_call_*）。
      // 同样使用 substr 前缀比较而非 LIKE，避免 `_` 通配符误伤其他业务事件。
      env.DB.prepare("SELECT * FROM events WHERE project_id=? AND substr(type,1,10) <> 'model_call' ORDER BY datetime(created_at) DESC,id DESC LIMIT 1").bind(projectId).first(),
    ]);
    let latestPayload = {};
    try { latestPayload = JSON.parse(latestEvent?.payload || "{}"); } catch (_error) { latestPayload = {}; }
    const tasks = (tasksResult.results || []).map(itemPayload);
    const revisionBlocker = tasks.find((item) => ["revision_requested", "awaiting_verification"].includes(item.status)) || null;
    return json({ project, role: current.role, members: membersResult.results || [], authorizations: authorizationsResult.results || [], tasks, revisionBlocker, latestEvent: latestEvent ? { type: latestEvent.type, actorRole: latestEvent.actor_role, createdAt: latestEvent.created_at, payload: latestPayload } : null, sla: { verificationBusinessDays: 2, supplementBusinessDays: 5, ownerDecisionBusinessDays: 5 } });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
