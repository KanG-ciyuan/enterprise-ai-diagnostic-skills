import { cors, formalActor, httpError, json, requireAuthorizedProject, requireMembership } from "../../../_shared.js";

const allowedVisibility = new Set(["project", "external_builder", "verifier", "owner", "employee"]);
const allowedSourceTypes = new Set(["pdf", "image", "csv", "xlsx", "text"]);

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["employee", "verifier", "external_builder"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    let sql = "SELECT id,project_id,material_key,version,previous_version_id,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference,metadata_json,reviewed_by_account_id,reviewed_at,review_reason,created_at FROM evidence_materials WHERE project_id=?";
    const binds = [params.projectId];
    if (current.role !== "external_builder") {
      sql += " AND (visibility='project' OR visibility=?)";
      binds.push(current.role);
    }
    if (current.role === "employee") {
      sql += " AND work_item_id IN (SELECT id FROM work_items WHERE project_id=? AND (assignee_account_id=? OR source_employee_account_id=?))";
      binds.push(params.projectId, current.accountId, current.accountId);
    }
    if (current.role === "verifier") {
      sql += " AND (work_item_id IS NULL OR work_item_id IN (SELECT id FROM work_items WHERE project_id=? AND assigned_verifier_id=?))";
      binds.push(params.projectId, current.accountId);
    }
    sql += " ORDER BY created_at DESC";
    const result = await env.DB.prepare(sql).bind(...binds).all();
    return json({ materials: (result.results || []).map((material) => ({ ...material, materialKey: material.material_key, previousVersionId: material.previous_version_id || null, sourceType: material.source_type })) });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    if (current.role !== "external_builder") return httpError("只有外部建设方可以登记证据材料", 403);
    const body = await request.json().catch(() => ({}));
    const authorizationRecordId = String(body.authorizationRecordId || "").trim();
    const authorization = await env.DB.prepare("SELECT id,status FROM enterprise_authorizations WHERE id=? AND project_id=?")
      .bind(authorizationRecordId, params.projectId).first();
    if (!authorization) return httpError("授权记录不存在或不属于当前项目", 422);
    const label = String(body.label || "").trim();
    const reference = String(body.reference || "").trim();
    const sourceType = String(body.sourceType || "").trim();
    const visibility = String(body.visibility || "project").trim();
    if (!label || !reference || !allowedSourceTypes.has(sourceType) || !allowedVisibility.has(visibility)) return httpError("材料名称、引用、来源类型或可见范围无效", 422);
    if (body.workItemId) {
      const item = await env.DB.prepare("SELECT 1 FROM work_items WHERE id=? AND project_id=?").bind(String(body.workItemId), params.projectId).first();
      if (!item) return httpError("关联任务不属于当前项目", 422);
    }
    const id = `MAT-${crypto.randomUUID()}`;
    const materialKey = `MKEY-${crypto.randomUUID()}`;
    const version = 1;
    await env.DB.prepare("INSERT INTO evidence_materials(id,project_id,material_key,version,previous_version_id,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference,metadata_json) VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, params.projectId, materialKey, version, sourceType, authorization.id, authorization.status, "pending", visibility, current.accountId, body.workItemId || null, label, reference, JSON.stringify(body.metadata || {})).run();
    const material = await env.DB.prepare("SELECT id,project_id,material_key,version,previous_version_id,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference,metadata_json,reviewed_by_account_id,reviewed_at,review_reason,created_at FROM evidence_materials WHERE id=? AND project_id=?")
      .bind(id, params.projectId).first();
    return json({ material: { ...material, materialKey: material.material_key, previousVersionId: material.previous_version_id || null, sourceType: material.source_type } }, 201);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
