import { cors, findIdempotent, formalActor, httpError, idempotencyKey, json } from "../_shared.js";

export async function onRequestGet({ request, env }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    if (current.role !== "account" && current.role !== "external_builder") return httpError("只有外部改造方可以创建项目", 403);
    const result = await env.DB.prepare("SELECT p.* FROM projects p JOIN project_memberships m ON m.project_id=p.id WHERE m.account_id=? AND m.status='active' ORDER BY p.id").bind(current.accountId).all();
    return json({ projects: result.results || [] });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}

export async function onRequestPost({ request, env }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    // Creating a project grants the creator an external_builder membership, so it
    // is the point where builder standing is handed out. Gate it on the account's
    // own role, not on the session's project-scoped role: an account-scoped
    // session reports "account" for a provisioned builder AND for a revoked
    // member or a two-project employee, and those must not be treated alike.
    // See PRIV-P1-009.
    if (current.accountRole !== "external_builder") return httpError("只有外部改造方可以创建项目", 403);
    const key = idempotencyKey(request).trim();
    if (!key) return httpError("创建项目需要 Idempotency-Key", 422);
    const replay = await findIdempotent(env.DB, current, "__account_scope__", "project-create", key);
    if (replay) {
      const body = await request.clone().json().catch(() => ({}));
      const original = replay.project || {};
      if (String(body.name || "").trim() !== original.name || String(body.scope || "").trim() !== original.scope) return httpError("同一请求键不能用于不同项目内容", 409);
      return json(replay, 201);
    }
    const body = await request.json();
    const name = String(body.name || "").trim();
    const scope = String(body.scope || "").trim();
    if (!name || !scope) return httpError("项目名称和范围不能为空", 422);
    const projectId = `PRJ-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const response = { project: { id: projectId, name, scope, stage: "scope", status: "draft", authorization_stage: "draft", evidence_level: "unknown", created_by_role: "external_builder", created_by_account_id: current.accountId } };
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES (?,?,?,?,?,?,?,?,?)").bind(projectId, name, scope, "scope", "draft", "unknown", "external_builder", current.accountId, "draft"),
        env.DB.prepare("INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES (?,?,?,?,?)").bind(projectId, current.accountId, "external_builder", "project", "active"),
        env.DB.prepare("INSERT INTO idempotency_records(account_id,project_id,action,request_key,response_json) VALUES (?,?,?,?,?)").bind(current.accountId, "__account_scope__", "project-create", key, JSON.stringify(response)),
      ]);
    } catch (_conflict) {
      const winner = await findIdempotent(env.DB, current, "__account_scope__", "project-create", key);
      if (winner) {
        if (winner.project?.name !== name || winner.project?.scope !== scope) return httpError("同一请求键不能用于不同项目内容", 409);
        return json(winner, 201);
      }
      return httpError("项目创建发生并发冲突，请使用同一请求键重试", 409);
    }
    const project = await env.DB.prepare("SELECT * FROM projects WHERE id=?").bind(projectId).first();
    return json({ project }, 201);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
