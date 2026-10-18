import { cors, formalActor, httpError, json, requireAuthorizedProject, requireMembership } from "../../../../_shared.js";

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const projectId = params.projectId;
    if (!projectId.startsWith("PRJ-")) return httpError("正式核验队列需要正式项目会话", 401);
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, projectId, current, ["verifier"]);
    await requireAuthorizedProject(env.DB, projectId);
    const result = await env.DB.prepare("SELECT cf.*,wi.title AS work_item_title,wi.status AS work_item_status,wi.assigned_verifier_id,wi.alternative_explanations_json FROM candidate_facts cf JOIN work_items wi ON wi.id=cf.work_item_id AND wi.project_id=cf.project_id WHERE cf.project_id=? AND wi.stage='facts' AND wi.status IN ('awaiting_verification','blocked') AND cf.status IN ('open','insufficient_evidence','awaiting_second_confirmation') AND ((cf.status!='awaiting_second_confirmation' AND wi.assigned_verifier_id=?) OR (cf.status='awaiting_second_confirmation' AND cf.first_verified_by_account_id!=?)) ORDER BY CASE cf.status WHEN 'awaiting_second_confirmation' THEN 0 ELSE 1 END,cf.work_item_id,cf.created_at").bind(projectId, current.accountId, current.accountId).all();
    const progressRow = await env.DB.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN cf.status IN ('confirmed','awaiting_second_confirmation') THEN 1 ELSE 0 END) AS completed FROM candidate_facts cf JOIN work_items wi ON wi.id=cf.work_item_id WHERE cf.project_id=? AND wi.assigned_verifier_id=? AND cf.required=1").bind(projectId, current.accountId).first();
    const secondProgressRow = await env.DB.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN fsc.id IS NOT NULL THEN 1 ELSE 0 END) AS completed FROM candidate_facts cf JOIN work_items wi ON wi.id=cf.work_item_id LEFT JOIN fact_second_confirmations fsc ON fsc.fact_id=cf.id AND fsc.confirmer_identity=? WHERE cf.project_id=? AND cf.required=1 AND cf.first_verified_by_account_id IS NOT NULL AND cf.first_verified_by_account_id!=? AND wi.assigned_verifier_id!=? AND (cf.status='awaiting_second_confirmation' OR fsc.id IS NOT NULL)").bind(current.accountId, projectId, current.accountId, current.accountId).first();
    const responsibleResult = await env.DB.prepare("SELECT pm.account_id,a.name,pm.role FROM project_memberships pm JOIN accounts a ON a.id=pm.account_id WHERE pm.project_id=? AND pm.status='active' AND a.status='active' AND pm.role='employee' ORDER BY a.name").bind(projectId).all();
    const materialsResult = await env.DB.prepare("SELECT id,project_id,material_key,version,source_type,authorization_record_id,authorization_status,integrity_status,visibility,work_item_id,label,reference,created_at FROM evidence_materials WHERE project_id=? AND (visibility='project' OR visibility='verifier') ORDER BY created_at DESC").bind(projectId).all();
    const assignedWorkItemIds = new Set((result.results || []).map((row) => row.work_item_id));
    const materials = (materialsResult.results || []).filter((material) => !material.work_item_id || assignedWorkItemIds.has(material.work_item_id));
    const historyResult = await env.DB.prepare("SELECT fj.id AS judgment_id,fj.work_item_id,fj.fact_id,fj.decision,fj.reason,fj.correction,fj.source_refs,fj.flow_card_version,fj.evidence_version,fj.created_at,wi.title AS work_item_title,a.name AS verifier_name FROM fact_judgments fj JOIN work_items wi ON wi.id=fj.work_item_id AND wi.project_id=? LEFT JOIN accounts a ON a.id=fj.actor_id WHERE fj.actor_id=? ORDER BY datetime(fj.created_at) DESC,fj.id DESC").bind(projectId, current.accountId).all();
    const history = (historyResult.results || []).map((entry) => ({
      judgmentId: entry.judgment_id,
      workItemId: entry.work_item_id,
      workItemTitle: entry.work_item_title,
      factId: entry.fact_id,
      decision: entry.decision,
      reason: entry.reason,
      correction: entry.correction || null,
      sourceRefs: JSON.parse(entry.source_refs || "[]"),
      flowCardVersion: Number(entry.flow_card_version || 1),
      evidenceVersion: Number(entry.evidence_version || 1),
      signedByAccountId: current.accountId,
      signedByName: entry.verifier_name || null,
      createdAt: entry.created_at,
    }));
    const facts = [];
    for (const row of result.results || []) {
      const supplement = await env.DB.prepare("SELECT id,fact_id,requested_material,responsible_person,responsible_account_id,deadline,recovery_entry,status,old_evidence_version,new_evidence_version,material_id FROM evidence_supplements WHERE fact_id=? ORDER BY created_at DESC LIMIT 1").bind(row.id).first();
      // V0.1-01 / D-1：核验人必须能"看到当前等级"，否则无法判断该不该重新定级。
      // 等级（来源强度）与 status（是否已确认）是两个正交维度，这里一并返回。
      const level = String(row.evidence_level || "").toUpperCase() || null;
      const requiresAiLabel = level === "E5" || Number(row.evidence_labeled || 0) === 1;
      facts.push({
        factId: row.id, projectId: row.project_id, workItemId: row.work_item_id, workItemTitle: row.work_item_title,
        factType: row.fact_type, claim: row.claim, sourceField: row.source_field, required: Boolean(row.required),
        impactLevel: row.impact_level, secondConfirmationStatus: row.second_confirmation_status,
        materialStatus: row.material_status, status: row.status, correction: row.correction || null,
        // 证据等级三件套：等级 / 等级来源 / 是否必须显示 AI 假设标记
        evidenceLevel: level,
        evidenceLevelLabel: level || "未定级",
        evidenceLevelSource: row.evidence_level_source || null,
        evidenceLevelUpdatedAt: row.evidence_level_updated_at || null,
        evidenceLevelUpdatedBy: row.evidence_level_updated_by_account_id || null,
        requiresAiLabel,
        aiLabel: requiresAiLabel ? "AI假设，待验证" : null,
        impactLevelReason: row.impact_level_reason || null,
        secondConfirmationAction: row.status === "awaiting_second_confirmation" ? "second_confirmation" : null,
        flowCardVersion: Number(row.flow_card_version || 1), evidenceVersion: Number(row.evidence_version || 1), sourceRefs: JSON.parse(row.source_refs_json || "[]"),
        eligibleMaterials: materials.filter((material) => !material.work_item_id || material.work_item_id === row.work_item_id).map((material) => ({ ...material, materialId: material.id, materialKey: material.material_key, sourceType: material.source_type, authorizationRecordId: material.authorization_record_id, authorizationStatus: material.authorization_status, integrityStatus: material.integrity_status })),
        supplementation: supplement || null,
        // PILOT-07C/R3：把该 work_item 的员工推断判定/更正透给核验人。
        // 只读扩展：复用上面已经按 projectId + 核验人 scope 过滤过的同一条 SELECT
        // （cf.* 已含 alternative_explanations_json），因此**不扩大项目访问范围**，
        // 不返回其他项目/未授权员工的数据，也不改变任何核验结论或证据等级。
        alternativeExplanations: parseAlternativeExplanations(row.alternative_explanations_json),
      });
    }
    const total = Number(progressRow?.total || 0) + Number(secondProgressRow?.total || 0);
    const completed = Number(progressRow?.completed || 0) + Number(secondProgressRow?.completed || 0);
    return json({ facts, items: facts, materials, history, responsibleMembers: responsibleResult.results || [], progress: { current: facts.length ? Math.min(total, completed + 1) : total, total, completed }, role: "verifier", queue: "待我确认" });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}

/**
 * PILOT-07C/R3：安全解析 work_items.alternative_explanations_json。
 * 历史数据可能为空、非数组或非法 JSON —— 一律降级为空数组，绝不抛错。
 */
function parseAlternativeExplanations(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}
