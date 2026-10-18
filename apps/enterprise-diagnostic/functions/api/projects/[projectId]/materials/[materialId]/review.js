import { cors, formalActor, httpError, json, requireAuthorizedProject, requireMembership } from "../../../../../_shared.js";

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["verifier"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    const body = await request.json().catch(() => ({}));
    const integrityStatus = body.decision === "verified" ? "verified" : body.decision === "rejected" ? "rejected" : "";
    const reviewReason = String(body.reason || "").trim();
    if (!integrityStatus || !reviewReason) return httpError("材料复核必须包含决定和理由", 422);
    const material = await env.DB.prepare("SELECT em.*,wi.assigned_verifier_id FROM evidence_materials em LEFT JOIN work_items wi ON wi.id=em.work_item_id AND wi.project_id=em.project_id WHERE em.id=? AND em.project_id=?")
      .bind(params.materialId, params.projectId).first();
    if (!material) return httpError("材料不存在", 404);
    if (material.work_item_id && material.assigned_verifier_id !== current.accountId) return httpError("只有指定核验人可以复核该任务材料", 403);
    if (material.created_by_account_id === current.accountId) return httpError("材料登记人不能自我复核", 403);
    const result = await env.DB.prepare("UPDATE evidence_materials SET integrity_status=?,reviewed_by_account_id=?,reviewed_at=CURRENT_TIMESTAMP,review_reason=? WHERE id=? AND project_id=? AND integrity_status='pending'")
      .bind(integrityStatus, current.accountId, reviewReason, params.materialId, params.projectId).run();
    if (!Number(result.meta?.changes || 0)) return httpError("材料已经复核", 409);
    const reviewed = await env.DB.prepare("SELECT id,project_id,version,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference,reviewed_by_account_id,reviewed_at,review_reason FROM evidence_materials WHERE id=? AND project_id=?")
      .bind(params.materialId, params.projectId).first();
    return json({ material: { ...reviewed, sourceType: reviewed.source_type } });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
