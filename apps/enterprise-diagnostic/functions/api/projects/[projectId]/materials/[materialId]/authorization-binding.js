import { cors, findIdempotent, formalActor, httpError, idempotencyKey, json, requireAuthorizedProject, requireMembership } from "../../../../../_shared.js";

function payload(material) {
  return {
    id: material.id,
    projectId: material.project_id,
    materialKey: material.material_key,
    version: Number(material.version),
    authorizationRecordId: material.authorization_record_id,
    authorizationStatus: material.authorization_status,
    integrityStatus: material.integrity_status,
  };
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    const key = idempotencyKey(request).trim();
    if (!key) return httpError("绑定材料授权需要 Idempotency-Key", 422);
    const replay = await findIdempotent(env.DB, current, params.projectId, "material-authorization-binding", key);
    if (replay) return json(replay);
    const body = await request.json().catch(() => ({}));
    const authorizationRecordId = String(body.authorizationRecordId || "").trim();
    const authorization = await env.DB.prepare("SELECT id,status FROM enterprise_authorizations WHERE id=? AND project_id=?").bind(authorizationRecordId, params.projectId).first();
    if (!authorization) return httpError("授权记录不存在或不属于当前项目", 422);
    if (authorization.status !== "authorized") return httpError("只能绑定企业已确认的授权记录", 409, "authorization_not_confirmed");
    const material = await env.DB.prepare("SELECT * FROM evidence_materials WHERE id=? AND project_id=?").bind(params.materialId, params.projectId).first();
    if (!material) return httpError("材料不存在", 404);
    if (!String(material.material_key || "").startsWith("SUPMAT-") || !material.work_item_id) return httpError("只有补证材料可以在此绑定授权", 422);
    if (material.authorization_record_id) return httpError("材料已经绑定授权记录，不能改绑", 409);
    const eventId = `EVT-MATERIAL-BIND-${params.materialId}-${authorization.id}`;
    const response = { material: payload({ ...material, authorization_record_id: authorization.id, authorization_status: authorization.status }) };
    const result = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO idempotency_records(account_id,project_id,action,request_key,response_json) SELECT ?,?,'material-authorization-binding',?,? FROM evidence_materials WHERE id=? AND project_id=? AND authorization_record_id IS NULL AND authorization_status='pending'").bind(current.accountId, params.projectId, key, JSON.stringify(response), params.materialId, params.projectId),
      env.DB.prepare("UPDATE evidence_materials SET authorization_record_id=?,authorization_status=? WHERE id=? AND project_id=? AND authorization_record_id IS NULL AND authorization_status='pending' AND EXISTS (SELECT 1 FROM idempotency_records WHERE account_id=? AND project_id=? AND action='material-authorization-binding' AND request_key=?)").bind(authorization.id, authorization.status, params.materialId, params.projectId, current.accountId, params.projectId, key),
      env.DB.prepare("INSERT OR IGNORE INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,project_id,work_item_id,'material_authorization_bound','external_builder',?,? FROM evidence_materials WHERE id=? AND project_id=? AND authorization_record_id=? AND EXISTS (SELECT 1 FROM idempotency_records WHERE account_id=? AND project_id=? AND action='material-authorization-binding' AND request_key=?)").bind(eventId, current.accountId, JSON.stringify({ materialId: params.materialId, authorizationRecordId: authorization.id, authorizationStatus: authorization.status }), params.materialId, params.projectId, authorization.id, current.accountId, params.projectId, key),
    ]);
    if (!Number(result[0]?.meta?.changes || 0)) {
      const concurrentReplay = await findIdempotent(env.DB, current, params.projectId, "material-authorization-binding", key);
      if (concurrentReplay) return json(concurrentReplay);
      return httpError("材料授权状态已变化，请刷新后重试", 409);
    }
    return json(response);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
