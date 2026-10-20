import { actor, assertSchemaReady, cors, demoActor, formalActor, httpError, json, requireMembership } from "../../../_shared.js";

export async function onRequest({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    // R2A F1: readiness before demo/formal branch DB access.
    await assertSchemaReady(env.DB);
    const formal = params.projectId.startsWith("PRJ-");
    const current = formal ? await formalActor(request, env.DB) : demoActor(request);
    if (!(await env.DB.prepare("SELECT 1 FROM projects WHERE id=?").bind(params.projectId).first())) return httpError("项目不存在", 404);
    // formalActor + project_memberships is the server-side scope boundary.
    if (formal) await requireMembership(env.DB, params.projectId, current);
    let sql = "SELECT e.* FROM events e WHERE e.project_id = ?";
    const binds = [params.projectId];
    // PILOT-09A-FIX2B/R2：内部模型调用计量事件（model_call_*）不属于业务事件，
    // 不得出现在员工 / external_builder 的业务事件列表中（verifier/owner 已有
    // type 白名单，本条件对其为无操作，可见性不变）。
    // 注意：**不使用 LIKE** —— `_` 在 LIKE 中是单字符通配符，
    // 用 `type NOT LIKE 'model_call_%'` 会连带误伤（例如 modelXcall…）。
    // 这里用 substr 前缀比较，语义精确且不受通配符影响。
    sql += " AND substr(e.type,1,10) <> 'model_call'";

    if (formal && current.role === "employee") { sql += " AND (e.actor_id=? OR EXISTS (SELECT 1 FROM work_items wi WHERE wi.id=e.work_item_id AND (wi.assignee_account_id=? OR wi.source_employee_account_id=?)))"; binds.push(current.accountId, current.accountId, current.accountId); }
    else if (formal && current.role === "verifier") sql += " AND e.type IN ('handoff','fact_confirmed','evidence_insufficient','evidence_provided','decision_packet_verified')";
    else if (formal && current.role === "owner") sql += " AND e.type IN ('risk_summary_published','owner_decision_recorded','revision_requested')";
    sql += " ORDER BY e.id";
    const result = await env.DB.prepare(sql).bind(...binds).all();
    const events = (result.results || []).map((event) => {
      let payload = {};
      try { payload = JSON.parse(event.payload || "{}"); } catch (_error) { payload = {}; }
      return { ...event, projectId: event.project_id, workItemId: event.work_item_id, actorRole: event.actor_role, actorId: event.actor_id, createdAt: event.created_at, payload };
    });
    return json({ events });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
