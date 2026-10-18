import { actor, cors, formalActor, httpError, itemPayload, json, requireAuthorizedProject, requireItem, requireMembership } from "../../../_shared.js";
import { findInvalidatablePacketsReferencing, stalePacketStatements } from "../../formal/decision-packets/_facts.js";

const normalizedRefs = (value) => Array.isArray(value) ? [...new Set(value.map(String).map((entry) => entry.trim()).filter(Boolean))] : [];

/**
 * V0.1-01 — fact-level E1–E5 evidence grade.
 *
 * The grade axis is INDEPENDENT of the confirmation axis (`status`). A fact can be
 * confirmed while its grade is still unknown, and graded while still open. `null`
 * means "未定级 / not graded" and is the historical default — there is deliberately
 * no backfill, because writing a grade nobody decided would fabricate evidence.
 *
 * `E5` is a model inference or analyst hypothesis. It may be recorded and may guide
 * further verification, but it can never stand as a confirmed fact: packet validation
 * in decision-packets/_facts.js refuses a confirmed E5 fact at draft/verify/publish.
 */
const ALLOWED_EVIDENCE_LEVELS = ["E1", "E2", "E3", "E4", "E5"];

function normalizeEvidenceLevel(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return "";
  return ALLOWED_EVIDENCE_LEVELS.includes(raw) ? raw : "";
}

/** A grade that must always render the "AI假设，待验证" label. */
const requiresLabel = (level) => level === "E5";

/**
 * V0.1-01b — high-impact categories that must enter second confirmation.
 *
 * Covers the full set the shared contract requires: 金额 (amount), 工时 (labour
 * hours), 成本 (cost), 岗位调整 (role/headcount change) and 合规 (compliance).
 * The previous list missed 工时/成本/岗位调整 — exactly the facts a short-video
 * automation diagnosis is built on, and the ones that underpin the quotation.
 */
const HIGH_IMPACT_TOPICS = /customer\s*ownership|归属|amount|金额|approval\s*responsibility|审批责任|compliance|合规|major\s*risk|重大风险|工时|用时|耗时|人力|人工投入|成本|费用|报价|预算|岗位|职责调整|人员调整/i;

function classifyImpactLevel(claim) {
  return HIGH_IMPACT_TOPICS.test(String(claim || "")) ? "high" : "normal";
}

function addBusinessDays(start, days) {
  const result = new Date(start); let remaining = days;
  while (remaining > 0) { result.setUTCDate(result.getUTCDate() + 1); if (![0, 6].includes(result.getUTCDay())) remaining -= 1; }
  return result.toISOString();
}

async function resolveEligibleMaterials(db, projectId, role, sourceRefs) {
  const eligibleMaterials = [];
  for (const sourceRef of sourceRefs) {
    const material = await db.prepare("SELECT * FROM evidence_materials WHERE id = ? AND project_id = ?").bind(sourceRef, projectId).first();
    if (!material) {
      const elsewhere = await db.prepare("SELECT project_id FROM evidence_materials WHERE id=?").bind(sourceRef).first();
      if (elsewhere) throw httpError("cross_project_source_ref", 422);
      throw httpError("unknown_source_ref", 422);
    }
    if (material.authorization_status !== "authorized") throw httpError("unauthorized_source_ref", 422);
    if (material.integrity_status !== "verified") throw httpError("unverified_source_ref", 422);
    if (!["project", role].includes(material.visibility)) throw httpError("source_ref_not_visible", 403);
    eligibleMaterials.push(material);
  }
  if (eligibleMaterials.length !== sourceRefs.length) throw httpError("unsupported_source_ref", 422);
  return eligibleMaterials;
}

function advanceWorkItemStatement(db, itemId, factId, transitionKey, assignedVerifierId = null, assignmentVersion = null) {
  return db.prepare("UPDATE work_items SET stage=CASE WHEN NOT EXISTS (SELECT 1 FROM candidate_facts WHERE work_item_id=work_items.id AND required=1 AND status!='confirmed') THEN 'decision' ELSE 'facts' END,status=CASE WHEN NOT EXISTS (SELECT 1 FROM candidate_facts WHERE work_item_id=work_items.id AND required=1 AND status!='confirmed') THEN 'awaiting_decision' ELSE 'awaiting_verification' END,assignee_role=CASE WHEN NOT EXISTS (SELECT 1 FROM candidate_facts WHERE work_item_id=work_items.id AND required=1 AND status!='confirmed') THEN 'owner' ELSE 'verifier' END,assignee_label=CASE WHEN NOT EXISTS (SELECT 1 FROM candidate_facts WHERE work_item_id=work_items.id AND required=1 AND status!='confirmed') THEN '企业负责人' ELSE '流程核验人员' END,assignee_account_id=CASE WHEN NOT EXISTS (SELECT 1 FROM candidate_facts WHERE work_item_id=work_items.id AND required=1 AND status!='confirmed') THEN NULL ELSE assigned_verifier_id END,judgment_status=CASE WHEN NOT EXISTS (SELECT 1 FROM candidate_facts WHERE work_item_id=work_items.id AND required=1 AND status!='confirmed') THEN 'confirmed' ELSE 'open' END,evidence_completeness=CASE WHEN NOT EXISTS (SELECT 1 FROM candidate_facts WHERE work_item_id=work_items.id AND required=1 AND status!='confirmed') THEN 100 ELSE evidence_completeness END,blocking_reason=CASE WHEN NOT EXISTS (SELECT 1 FROM candidate_facts WHERE work_item_id=work_items.id AND required=1 AND status!='confirmed') THEN '等待负责人决定是否进入影子试点' ELSE '仍有必需事实待确认' END,next_action=CASE WHEN NOT EXISTS (SELECT 1 FROM candidate_facts WHERE work_item_id=work_items.id AND required=1 AND status!='confirmed') THEN '审阅核验结论' ELSE '继续逐条核验候选事实' END WHERE id=? AND EXISTS (SELECT 1 FROM candidate_facts WHERE id=? AND last_transition_key=?) AND (? IS NULL OR (assigned_verifier_id=? AND assignment_version=?))").bind(itemId, factId, transitionKey, assignedVerifierId, assignedVerifierId, assignmentVersion);
}

async function conflictResponse(db, itemId, factId) {
  const currentItem = await requireItem(db, itemId);
  const currentFact = await db.prepare("SELECT * FROM candidate_facts WHERE id=? AND work_item_id=?").bind(factId, itemId).first();
  return json({ code: "transition_conflict", detail: "事实状态已变化，请刷新后重试。", item: itemPayload(currentItem), fact: currentFact }, 409);
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const item = await requireItem(env.DB, params.itemId);
    const assignmentVersion = Number(item.assignment_version || 1);
    const formal = item.project_id.startsWith("PRJ-");
    const current = formal ? await formalActor(request, env.DB) : actor(request);
    if (formal) {
      await requireMembership(env.DB, item.project_id, current, ["verifier"]);
      await requireAuthorizedProject(env.DB, item.project_id);
    }
    else if (request.headers.get("Authorization")) return httpError("演示项目不接受正式会话", 401);
    if (current.role !== "verifier") return httpError("只有核验人员可以确认事实", 403);
    const body = await request.json().catch(() => ({}));
    const isSecondConfirmation = body.action === "second_confirmation";
    // D-1：等级修正针对「已确认」事实，而任务此时通常已推进到 decision 阶段。
    // 因此该专项动作不受「必须在核验阶段」这一状态门限制；其余动作保持不变。
    const isLevelCorrection = body.action === "correct_evidence_level";
    if (!isLevelCorrection && (item.stage !== "facts" || !["awaiting_verification", "blocked"].includes(item.status))) return httpError("当前任务不在事实核验阶段", 409);
    if (formal && !isSecondConfirmation && !isLevelCorrection && item.assigned_verifier_id !== current.accountId) return httpError("当前事实未分配给你核验", 403);
    const factId = String(body.factId || "").trim();
    if (!factId) return httpError("核验必须指定 factId", 422);
    const fact = await env.DB.prepare("SELECT * FROM candidate_facts WHERE id=? AND work_item_id=? AND project_id=?").bind(factId, item.id, item.project_id).first();
    if (!fact) return httpError("候选事实不存在或不属于当前任务", 404);
    const actorId = current.accountId || current.userId;
    const transitionKey = crypto.randomUUID();

    // ── V0.1-01b: 漏判补救 — 核验人把漏判事实升级为高影响 ────────────────
    // `impact_level` was decided once, at fact creation, by a regex on the claim
    // (employee-submission.js). Nothing in the codebase could change it afterwards,
    // so a missed 工时/成本/岗位 fact travelled all the way into the plan and the
    // quotation as `normal`, never entering second confirmation.
    //
    // The upgrade is auditable (actor, time, reason, old→new) and it re-arms the
    // gate: `second_confirmation_status` goes back to `pending`, so the fact cannot
    // be published until a second verifier has independently confirmed it.
    // ── V0.1-01 / D-1: 已确认事实的最小等级修正动作 ──────────────────────
    // 状态机不允许对已确认事实重复"首核"，因此等级一旦定错就无法在核验时点更正。
    // 这里提供一个**专项**修正动作，而不是放宽首核条件，以免削弱状态机。
    //
    // 约束（逐条对应验收要求）：
    //   · 仅核验人可以调用（外层已强制 requireMembership(['verifier']) + 角色校验）；
    //   · 必须填写修正理由；
    //   · 保留修改前后等级、操作者与时间（事件 payload + 事实行的审计列）；
    //   · **不得借此绕过二次确认**：本动作既不改变 status，也不改变
    //     second_confirmation_status，因此高影响事实仍必须完成独立二次确认才能进入方案；
    //   · E5 仍受发布限制约束（validated at packet time）；
    //   · 若该事实被已发布决策包引用，修正会触发既有失效机制（与升级同源）。
    if (body.action === "correct_evidence_level") {
      const reason = String(body.reason || "").trim();
      if (!reason) return httpError("修正证据等级必须填写修正理由", 422);
      const target = normalizeEvidenceLevel(body.evidenceLevel);
      if (!target) return httpError("证据等级必须是 E1–E5 之一", 422);
      const currentLevel = normalizeEvidenceLevel(fact.evidence_level) || null;
      if (currentLevel === target) return httpError("该事实当前已是该证据等级", 409);
      const correctionKey = crypto.randomUUID();
      // 等级修正属于"改变结论依据"的事实变更：与撤回/升级同源，必须让已发布包失效。
      const affected = await findInvalidatablePacketsReferencing(env.DB, item.project_id, factId);
      const { statements: staleStatements } = stalePacketStatements(env.DB, {
        packets: affected, projectId: item.project_id, factId,
        actorRole: "verifier", actorId, reason: `证据等级修正 ${currentLevel || "未定级"} → ${target}：${reason}`,
      });
      const correctionPayload = JSON.stringify({
        factId,
        previousEvidenceLevel: currentLevel,
        evidenceLevel: target,
        evidenceLabeled: requiresLabel(target),
        reason,
        actorId,
        invalidatedPackets: affected.map((packet) => packet.id),
        note: "等级修正不改变确认状态，也不改变二次确认要求",
      });
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE candidate_facts SET evidence_level=?,evidence_level_source='verifier_correction',evidence_labeled=?,evidence_level_updated_at=CURRENT_TIMESTAMP,evidence_level_updated_by_account_id=?,last_transition_key=? WHERE id=? AND work_item_id=? AND COALESCE(evidence_level,'')!=?").bind(target, requiresLabel(target) ? 1 : 0, actorId, correctionKey, factId, item.id, target),
        env.DB.prepare("INSERT INTO fact_judgments(id,work_item_id,fact_id,decision,reason,correction,source_refs,actor_id,flow_card_version,evidence_version) SELECT ?,work_item_id,id,?,?,NULL,'[]',?,flow_card_version,evidence_version FROM candidate_facts WHERE id=? AND last_transition_key=?").bind(`JDG-${crypto.randomUUID()}`, `evidence_level_correction:${currentLevel || "null"}->${target}`, reason, actorId, factId, correctionKey),
        env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,project_id,work_item_id,'fact_evidence_level_corrected','verifier',?,? FROM candidate_facts WHERE id=? AND last_transition_key=?").bind(`EVT-${crypto.randomUUID()}`, actorId, correctionPayload, factId, correctionKey),
        ...staleStatements,
      ]);
      if (!Number(results[0]?.meta?.changes || 0)) return conflictResponse(env.DB, item.id, factId);
      const updated = await requireItem(env.DB, item.id);
      return json({ item: itemPayload(updated), evidenceLevelCorrection: JSON.parse(correctionPayload) });
    }

    if (body.action === "upgrade_impact") {
      const reason = String(body.reason || "").trim();
      if (!reason) return httpError("升级为高影响事实必须填写理由", 422);
      const target = String(body.impactLevel || "high").trim();
      if (!["high", "normal"].includes(target)) return httpError("影响级别无效", 422);
      if (fact.impact_level === target) return httpError("该事实当前已是该影响级别", 409);
      // The upgrader must be a verifier on this project; a downgrade is treated the
      // same way so that no level change can happen without a recorded reason.
      const upgradeKey = crypto.randomUUID();
      // A level change invalidates any published conclusion that cited this fact.
      const affected = target === "high" ? await findInvalidatablePacketsReferencing(env.DB, item.project_id, factId) : [];
      const { statements: staleStatements } = stalePacketStatements(env.DB, {
        packets: affected, projectId: item.project_id, factId,
        actorRole: "verifier", actorId, reason: `事实升级为高影响：${reason}`,
      });
      const upgradePayload = JSON.stringify({
        factId, from: fact.impact_level, to: target, reason, actorId,
        secondConfirmationStatus: target === "high" ? "pending" : "not_required",
        invalidatedPackets: affected.map((packet) => packet.id),
      });
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE candidate_facts SET impact_level=?,impact_level_updated_at=CURRENT_TIMESTAMP,impact_level_updated_by_account_id=?,impact_level_reason=?,second_confirmation_status=?,verified_by_account_id=NULL,last_transition_key=? WHERE id=? AND work_item_id=? AND impact_level!=?").bind(target, actorId, reason, target === "high" ? "pending" : "not_required", upgradeKey, factId, item.id, target),
        env.DB.prepare("INSERT INTO fact_judgments(id,work_item_id,fact_id,decision,reason,correction,source_refs,actor_id,flow_card_version,evidence_version) SELECT ?,work_item_id,id,?,?,NULL,'[]',?,flow_card_version,evidence_version FROM candidate_facts WHERE id=? AND last_transition_key=?").bind(`JDG-${crypto.randomUUID()}`, `impact_upgrade:${fact.impact_level}->${target}`, reason, actorId, factId, upgradeKey),
        env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,project_id,work_item_id,'fact_impact_upgraded','verifier',?,? FROM candidate_facts WHERE id=? AND last_transition_key=?").bind(`EVT-${crypto.randomUUID()}`, actorId, upgradePayload, factId, upgradeKey),
        ...staleStatements,
      ]);
      if (!Number(results[0]?.meta?.changes || 0)) return conflictResponse(env.DB, item.id, factId);
      const updated = await requireItem(env.DB, item.id);
      return json({ item: itemPayload(updated), impactUpgrade: JSON.parse(upgradePayload) });
    }

    // ── V0.1-01: 核验人可同时给出/修正证据等级（含审计）──────────────────
    // A level supplied on this call is recorded with the grading actor and time.
    const bodyLevel = normalizeEvidenceLevel(body.evidenceLevel);
    if (body.evidenceLevel !== undefined && String(body.evidenceLevel).trim() && !bodyLevel) {
      return httpError("证据等级必须是 E1–E5 之一", 422);
    }

    if (isSecondConfirmation) {
      const secondConfirmationReason = String(body.secondConfirmationReason || "").trim();
      if (fact.impact_level !== "high" || fact.status !== "awaiting_second_confirmation") return httpError("该事实当前不接受二次确认", 409);
      if (!secondConfirmationReason) return httpError("二次确认必须填写独立复核理由", 422);
      if (fact.first_verified_by_account_id === current.accountId) return httpError("首次核验人不能完成同一事实的二次确认", 403);
      if (fact.first_verified_by_account_id === actorId) return httpError("首次核验人不能完成同一事实的二次确认", 403);
      let sourceRefs = []; try { sourceRefs = JSON.parse(fact.source_refs_json || "[]"); } catch (_error) { sourceRefs = []; }
      if (!sourceRefs.length) return httpError("missing_source_refs", 409);
      await resolveEligibleMaterials(env.DB, item.project_id, current.role, sourceRefs);
      const confirmationId = `FSC-${crypto.randomUUID()}`;
      const confirmationPayload = JSON.stringify({ factId, firstVerifierAccountId: fact.first_verified_by_account_id, confirmerAccountId: actorId, reason: secondConfirmationReason, sourceRefs });
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE candidate_facts SET status='confirmed',second_confirmation_status='confirmed',verified_by_account_id=?,verified_at=CURRENT_TIMESTAMP,last_transition_key=? WHERE id=? AND work_item_id=? AND status='awaiting_second_confirmation' AND first_verified_by_account_id!=? AND (? = 0 OR EXISTS (SELECT 1 FROM work_items wi_guard WHERE wi_guard.id=? AND wi_guard.project_id=? AND wi_guard.assigned_verifier_id=? AND wi_guard.assignment_version=?))").bind(actorId, transitionKey, factId, item.id, actorId, formal ? 1 : 0, item.id, item.project_id, item.assigned_verifier_id, assignmentVersion),
        env.DB.prepare("INSERT INTO fact_second_confirmations(id,fact_id,project_id,work_item_id,first_verifier_account_id,confirmer_type,confirmer_identity,reason) SELECT ?,id,project_id,work_item_id,first_verified_by_account_id,'verifier',?,? FROM candidate_facts WHERE id=? AND last_transition_key=?").bind(confirmationId, actorId, secondConfirmationReason, factId, transitionKey),
        advanceWorkItemStatement(env.DB, item.id, factId, transitionKey, formal ? item.assigned_verifier_id : null, formal ? assignmentVersion : null),
        env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,project_id,work_item_id,'fact_second_confirmed','verifier',?,? FROM candidate_facts WHERE id=? AND last_transition_key=?").bind(`EVT-${crypto.randomUUID()}`, actorId, confirmationPayload, factId, transitionKey),
        env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,project_id,work_item_id,'handoff','verifier',?,? FROM candidate_facts WHERE id=? AND last_transition_key=? AND NOT EXISTS (SELECT 1 FROM candidate_facts pending WHERE pending.work_item_id=candidate_facts.work_item_id AND pending.required=1 AND pending.status!='confirmed')").bind(`EVT-${crypto.randomUUID()}`, actorId, JSON.stringify({ fromRole: "verifier", toRole: "owner", targetStage: "decision", sourceRefs }), factId, transitionKey),
      ]);
      if (!Number(results[0]?.meta?.changes || 0)) return conflictResponse(env.DB, item.id, factId);
      const updated = await requireItem(env.DB, item.id);
      return json({ item: itemPayload(updated), secondConfirmation: JSON.parse(confirmationPayload) });
    }

    if (!["open", "insufficient_evidence"].includes(fact.status)) return conflictResponse(env.DB, item.id, factId);
    const decision = body.decision === "different" ? "different_with_correction" : body.decision === "insufficient" ? "insufficient_evidence" : body.decision;
    if (!["same", "different_with_correction", "insufficient_evidence"].includes(decision)) return httpError("核验结果无效", 422);
    const reason = String(body.reason || "").trim();
    const sourceRefs = normalizedRefs(body.sourceRefs);
    if (!reason) return httpError("核验判断必须填写依据", 422);
    const correction = String(body.correction || "").trim();
    if (decision === "different_with_correction" && !correction) return httpError("不同事实必须填写修正结论", 422);
    let eligibleMaterials = [];
    if (decision !== "insufficient_evidence") {
      if (!sourceRefs.length) return httpError("missing_source_refs", 422);
      eligibleMaterials = await resolveEligibleMaterials(env.DB, item.project_id, current.role, sourceRefs);
    }
    const judgmentId = `JDG-${crypto.randomUUID()}`;
    const eventId = `EVT-${crypto.randomUUID()}`;

    if (decision === "insufficient_evidence") {
      const requestedMaterial = String(body.requestedMaterial || "").trim();
      const responsibleAccountId = String(body.responsibleAccountId || "").trim();
      if (!requestedMaterial || !responsibleAccountId) return httpError("证据不足时必须说明补什么并指定项目责任账号", 422);
      const responsible = await env.DB.prepare("SELECT pm.account_id,a.name FROM project_memberships pm JOIN accounts a ON a.id=pm.account_id WHERE pm.project_id=? AND pm.account_id=? AND pm.role='employee' AND pm.status='active' AND a.status='active'").bind(item.project_id, responsibleAccountId).first();
      if (!responsible) return httpError("补证责任账号必须是当前项目的一线员工", 422);
      const supplementId = `SUP-${crypto.randomUUID()}`; const evidenceVersion = Number(item.evidence_version || 1);
      const deadline = addBusinessDays(new Date(), 5); const recoveryEntry = `重新核验事实 ${factId}`;
      const payload = JSON.stringify({ factId, materialStatus: decision, reason, sourceRefs, requestedMaterial, responsiblePerson: responsible.name, responsibleAccountId, deadline, recoveryEntry, supplementId });
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE candidate_facts SET material_status='insufficient_evidence',status='insufficient_evidence',source_refs_json=?,first_verified_by_account_id=?,verified_by_account_id=?,verified_at=CURRENT_TIMESTAMP,last_transition_key=? WHERE id=? AND work_item_id=? AND status='open' AND (? = 0 OR EXISTS (SELECT 1 FROM work_items wi_guard WHERE wi_guard.id=? AND wi_guard.project_id=? AND wi_guard.assigned_verifier_id=? AND wi_guard.assignment_version=?))").bind(JSON.stringify(sourceRefs), actorId, actorId, transitionKey, factId, item.id, formal ? 1 : 0, item.id, item.project_id, current.accountId, assignmentVersion),
        env.DB.prepare("INSERT INTO evidence_supplements(id,work_item_id,fact_id,requested_material,responsible_person,responsible_account_id,deadline,recovery_entry,authorization_scope,source_refs,old_evidence_version,new_evidence_version,status) SELECT ?,work_item_id,id,?,?,?,?,?,'project',?,?,?,'waiting' FROM candidate_facts WHERE id=? AND last_transition_key=?").bind(supplementId, requestedMaterial, responsible.name || responsible.account_id, responsible.account_id, deadline, recoveryEntry, JSON.stringify(sourceRefs), evidenceVersion, evidenceVersion + 1, factId, transitionKey),
        env.DB.prepare("UPDATE work_items SET status='blocked',judgment_status='blocked',supplement_id=?,blocking_reason='证据不足，等待补充材料',next_action=?,evidence_completeness=MIN(evidence_completeness,62) WHERE id=? AND EXISTS (SELECT 1 FROM candidate_facts WHERE id=? AND last_transition_key=?) AND (? = 0 OR (assigned_verifier_id=? AND assignment_version=?))").bind(supplementId, recoveryEntry, item.id, factId, transitionKey, formal ? 1 : 0, current.accountId, assignmentVersion),
        env.DB.prepare("INSERT INTO fact_judgments(id,work_item_id,fact_id,decision,reason,correction,source_refs,actor_id,flow_card_version,evidence_version) SELECT ?,work_item_id,id,?,?,NULL,?,?,flow_card_version,evidence_version FROM candidate_facts WHERE id=? AND last_transition_key=?").bind(judgmentId, decision, reason, JSON.stringify(sourceRefs), actorId, factId, transitionKey),
        env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,project_id,work_item_id,'evidence_insufficient','verifier',?,? FROM candidate_facts WHERE id=? AND last_transition_key=?").bind(eventId, actorId, payload, factId, transitionKey),
      ]);
      if (!Number(results[0]?.meta?.changes || 0)) return conflictResponse(env.DB, item.id, factId);
      const updated = await requireItem(env.DB, item.id);
      return json({ item: itemPayload(updated), judgment: JSON.parse(payload) });
    }

    const highImpact = fact.impact_level === "high";
    const factStatus = highImpact ? "awaiting_second_confirmation" : "confirmed";
    const secondStatus = highImpact ? "pending" : "not_required";
    // V0.1-01: record the grade supplied on this call, together with its audit trail.
    // An omitted level leaves the existing value untouched (never silently cleared)
    // and, for a brand-new fact, leaves it NULL = "未定级".
    const levelToStore = bodyLevel || normalizeEvidenceLevel(fact.evidence_level) || null;
    const levelChanged = levelToStore !== (fact.evidence_level || null);
    const levelStatement = levelChanged
      ? "evidence_level=?,evidence_level_source=?,evidence_labeled=?,evidence_level_updated_at=CURRENT_TIMESTAMP,evidence_level_updated_by_account_id=?,"
      : "";
    const payload = JSON.stringify({
      factId, materialStatus: decision, reason, correction: correction || null, sourceRefs,
      eligibleMaterialRefs: eligibleMaterials.map((material) => material.id),
      factStatus, secondConfirmationStatus: secondStatus,
      evidenceLevel: levelToStore, evidenceLabeled: requiresLabel(levelToStore), evidenceLabelRequired: requiresLabel(levelToStore),
    });
    const confirmStatement = env.DB.prepare(
      `UPDATE candidate_facts SET material_status=?,status=?,correction=?,source_refs_json=?,first_verified_by_account_id=?,verified_by_account_id=?,second_confirmation_status=?,${levelStatement}verified_at=CURRENT_TIMESTAMP,last_transition_key=? WHERE id=? AND work_item_id=? AND status IN ('open','insufficient_evidence') AND (? = 0 OR EXISTS (SELECT 1 FROM work_items wi_guard WHERE wi_guard.id=? AND wi_guard.project_id=? AND wi_guard.assigned_verifier_id=? AND wi_guard.assignment_version=?))`
    );
    const confirmBindings = [
      decision, factStatus, correction || null, JSON.stringify(sourceRefs), actorId, highImpact ? null : actorId, secondStatus,
      ...(levelChanged ? [levelToStore, body.evidenceLevel !== undefined ? "verifier" : "carried_forward", requiresLabel(levelToStore) ? 1 : 0, actorId] : []),
      transitionKey, factId, item.id, formal ? 1 : 0, item.id, item.project_id, current.accountId, assignmentVersion,
    ];
    // B-02: grading (or re-confirming) a fact that a published packet relies on does
    // not by itself invalidate that packet — the evidence grade is a property of the
    // evidence, not of the conclusion. Withdrawal and impact upgrade are the two
    // events that do (see evidence-supplement.js and the upgrade action above).
    const results = await env.DB.batch([
      confirmStatement.bind(...confirmBindings),
      env.DB.prepare("INSERT INTO fact_judgments(id,work_item_id,fact_id,decision,reason,correction,source_refs,actor_id,flow_card_version,evidence_version) SELECT ?,work_item_id,id,?,?,?,?,?,flow_card_version,evidence_version FROM candidate_facts WHERE id=? AND last_transition_key=?").bind(judgmentId, decision, reason, correction || null, JSON.stringify(sourceRefs), actorId, factId, transitionKey),
        advanceWorkItemStatement(env.DB, item.id, factId, transitionKey, formal ? current.accountId : null, formal ? assignmentVersion : null),
      env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,project_id,work_item_id,?,'verifier',?,? FROM candidate_facts WHERE id=? AND last_transition_key=?").bind(eventId, highImpact ? "fact_awaiting_second_confirmation" : "fact_confirmed", actorId, payload, factId, transitionKey),
      env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,project_id,work_item_id,'handoff','verifier',?,? FROM candidate_facts WHERE id=? AND last_transition_key=? AND NOT EXISTS (SELECT 1 FROM candidate_facts pending WHERE pending.work_item_id=candidate_facts.work_item_id AND pending.required=1 AND pending.status!='confirmed')").bind(`EVT-${crypto.randomUUID()}`, actorId, JSON.stringify({ fromRole: "verifier", toRole: "owner", targetStage: "decision", sourceRefs }), factId, transitionKey),
    ]);
    if (!Number(results[0]?.meta?.changes || 0)) return conflictResponse(env.DB, item.id, factId);
    const updated = await requireItem(env.DB, item.id);
    return json({ item: itemPayload(updated), judgment: JSON.parse(payload) });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
