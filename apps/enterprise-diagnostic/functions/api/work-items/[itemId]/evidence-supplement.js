import { cors, findIdempotent, formalActor, httpError, itemPayload, json, requireAuthorizedProject, requireItem, requireMembership } from "../../../_shared.js";
import { findInvalidatablePacketsReferencing, stalePacketStatements } from "../../formal/decision-packets/_facts.js";

const allowedSourceTypes = new Set(["pdf", "image", "csv", "xlsx", "text"]);

function addBusinessDays(start, days) {
  const result = new Date(start);
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (![0, 6].includes(result.getUTCDay())) remaining -= 1;
  }
  return result.toISOString();
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    const item = await requireItem(env.DB, params.itemId);
    if (!item.project_id.startsWith("PRJ-")) return httpError("补证恢复只适用于正式项目", 401);
    await requireMembership(env.DB, item.project_id, current, ["employee"]);
    await requireAuthorizedProject(env.DB, item.project_id);
    if (current.role !== "employee") return httpError("只有被指派的一线员工可以提交补证", 403);
    const supplement = await env.DB.prepare("SELECT * FROM evidence_supplements WHERE id=? AND work_item_id=? LIMIT 1").bind(item.supplement_id, item.id).first();
    const replayKey = supplement?.id || item.supplement_id || "";
    const replay = await findIdempotent(env.DB, current, item.project_id, "evidence-supplement", replayKey);
    if (replay) return json(replay);
    if (item.stage !== "facts" || item.status !== "blocked") return json({ code: "transition_conflict", detail: "当前事实不在等待补证状态", item: itemPayload(item) }, 409);
    const body = await request.json().catch(() => ({}));
    const material = String(body.material || "").trim();
    const reference = String(body.reference || "").trim();
    const sourceType = String(body.sourceType || "").trim();
    if (!material || !reference || !allowedSourceTypes.has(sourceType)) return httpError("请补充材料说明、外部材料引用和有效来源类型", 422);
    const suppliedMetadata = body.metadata && !Array.isArray(body.metadata) && typeof body.metadata === "object" ? body.metadata : {};
    if (!supplement || supplement.status !== "waiting") return json({ code: "transition_conflict", detail: "补证请求已变更，请刷新后重试", item: itemPayload(item) }, 409);
    const candidate_fact_id = supplement.fact_id;
    if (supplement.responsible_account_id && supplement.responsible_account_id !== current.accountId) return httpError("只有指定的项目责任账号可以提交本次补证", 403);
    const responsible = await env.DB.prepare("SELECT 1 FROM project_memberships WHERE project_id=? AND account_id=? AND status='active'").bind(item.project_id, current.accountId).first();
    if (!responsible) return httpError("补证责任账号已不是有效项目成员", 403);
    const oldEvidenceVersion = Number(item.evidence_version || 1);
    const newEvidenceVersion = oldEvidenceVersion + 1;
    const materialKey = `SUPMAT-${candidate_fact_id}`;
    const latestVersion = await env.DB.prepare("SELECT MAX(version) AS version FROM evidence_materials WHERE project_id=? AND material_key=?").bind(item.project_id, materialKey).first();
    const previousMaterialVersion = Number(latestVersion?.version || 0);
    const previous = previousMaterialVersion ? await env.DB.prepare("SELECT id FROM evidence_materials WHERE project_id=? AND material_key=? AND version=?").bind(item.project_id, materialKey, previousMaterialVersion).first() : null;
    const materialVersion = previousMaterialVersion + 1;
    const materialId = `MAT-${crypto.randomUUID()}`;
    const deadline = supplement.deadline || addBusinessDays(new Date(), 5);
    const recoveryEntry = supplement.recovery_entry || `重新核验事实 ${candidate_fact_id}`;
    const recovery = { factId: supplement.fact_id, oldEvidenceVersion, newEvidenceVersion, sourceRefs: [materialId], materialId, materialKey, version: materialVersion, previousVersionId: previous?.id || null, sourceType, authorizationStatus: "pending", integrityStatus: "pending", recoveryEntry, reason: "补证材料已登记为待审核版本，恢复同一候选事实" };
    const persisted = { ...item, status: "awaiting_verification", judgment_status: "open", evidence_version: newEvidenceVersion, blocking_reason: "新材料版本待授权与完整性核验", next_action: recoveryEntry };
    const response = { item: itemPayload(persisted), recovery };
    const actorId = current.accountId;
    const eventPayload = JSON.stringify(recovery);
    // ── B-01: 事实撤回 → 相关已发布结论失效 ──────────────────────────────
    // Line 58 below resets the fact to `open`, i.e. its confirmation lapses. Any
    // published decision packet that cited this fact is therefore no longer backed by
    // a confirmed fact, but nothing used to notice: packet validation only ran at
    // verify/publish time. Here the affected packets are marked `stale` in the SAME
    // batch as the withdrawal, so the invalidation cannot drift from its cause.
    // History is preserved: the packet row, its version and any owner_decisions stay.
    const affectedPackets = await findInvalidatablePacketsReferencing(env.DB, item.project_id, supplement.fact_id);
    const { statements: staleStatements, staled: staledPacketIds } = stalePacketStatements(env.DB, {
      packets: affectedPackets, projectId: item.project_id, factId: supplement.fact_id,
      actorRole: current.role, actorId,
      reason: "事实因补证被撤回，重新进入待核验状态，原已发布结论的依据已失效",
    });
    response.invalidatedPackets = staledPacketIds;
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE evidence_supplements SET status='provided',material=?,material_id=?,source_refs=?,provided_at=CURRENT_TIMESTAMP,new_evidence_version=?,deadline=?,recovery_entry=? WHERE id=? AND work_item_id=? AND status='waiting' AND old_evidence_version=? AND EXISTS (SELECT 1 FROM candidate_facts WHERE id=evidence_supplements.fact_id AND work_item_id=? AND status='insufficient_evidence' AND evidence_version=?) AND EXISTS (SELECT 1 FROM work_items WHERE id=? AND supplement_id=evidence_supplements.id AND stage='facts' AND status='blocked' AND evidence_version=?)").bind(material, materialId, JSON.stringify([materialId]), newEvidenceVersion, deadline, recoveryEntry, supplement.id, item.id, oldEvidenceVersion, item.id, oldEvidenceVersion, item.id, oldEvidenceVersion),
      env.DB.prepare("INSERT INTO evidence_materials(id,project_id,material_key,version,previous_version_id,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference,metadata_json) SELECT ?,?,?,?,?,?,NULL,'pending','pending','verifier',?,?,?,?,? FROM evidence_supplements WHERE id=? AND work_item_id=? AND status='provided' AND material_id=?").bind(materialId, item.project_id, materialKey, materialVersion, previous?.id || null, sourceType, current.accountId, item.id, supplement.requested_material, reference, JSON.stringify({ ...suppliedMetadata, supplementId: supplement.id, material }), supplement.id, item.id, materialId),
      env.DB.prepare("UPDATE candidate_facts SET status='open',material_status='unverified',source_refs_json='[]',evidence_version=? WHERE id=? AND work_item_id=? AND status='insufficient_evidence' AND evidence_version=? AND EXISTS (SELECT 1 FROM evidence_supplements WHERE id=? AND work_item_id=? AND status='provided' AND material_id=?)").bind(newEvidenceVersion, supplement.fact_id, item.id, oldEvidenceVersion, supplement.id, item.id, materialId),
      env.DB.prepare("UPDATE work_items SET status='awaiting_verification',judgment_status='open',evidence_version=?,blocking_reason='新材料版本待授权与完整性核验',next_action=? WHERE id=? AND stage='facts' AND status='blocked' AND supplement_id=? AND evidence_version=? AND EXISTS (SELECT 1 FROM evidence_supplements WHERE id=? AND work_item_id=? AND status='provided' AND material_id=?)").bind(newEvidenceVersion, recoveryEntry, item.id, supplement.id, oldEvidenceVersion, supplement.id, item.id, materialId),
      env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,project_id,id,'evidence_provided',?,?,? FROM work_items WHERE id=? AND status='awaiting_verification' AND evidence_version=? AND EXISTS (SELECT 1 FROM evidence_supplements WHERE id=? AND work_item_id=work_items.id AND status='provided' AND material_id=?)").bind(`EVT-${crypto.randomUUID()}`, current.role, actorId, eventPayload, item.id, newEvidenceVersion, supplement.id, materialId),
      env.DB.prepare("INSERT INTO idempotency_records(account_id,project_id,action,request_key,response_json) SELECT ?,?,?,?,? FROM work_items WHERE id=? AND status='awaiting_verification' AND evidence_version=? AND EXISTS (SELECT 1 FROM evidence_supplements WHERE id=? AND work_item_id=work_items.id AND status='provided' AND material_id=?)").bind(current.accountId, item.project_id, "evidence-supplement", replayKey, JSON.stringify(response), item.id, newEvidenceVersion, supplement.id, materialId),
      ...staleStatements,
    ]);
    if (!Number(results[0]?.meta?.changes || 0)) {
      const concurrentReplay = await findIdempotent(env.DB, current, item.project_id, "evidence-supplement", replayKey);
      if (concurrentReplay) return json(concurrentReplay);
      const currentItem = await requireItem(env.DB, item.id);
      return json({ code: "transition_conflict", detail: "补证状态已变更，本次请求未写入", item: itemPayload(currentItem) }, 409);
    }
    return json(response);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
