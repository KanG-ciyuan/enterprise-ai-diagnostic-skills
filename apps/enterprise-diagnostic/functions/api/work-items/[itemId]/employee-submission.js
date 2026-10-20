import { canonicalVerdict, resolveInferenceJudgment, VERDICT_UNJUDGED } from "../../agent/_adapter.js";
import { submissionEvidenceSummary, validateSubmissionEvidence } from "../../agent/_evidence.js";
import { assertSchemaReady, cors, demoActor, findIdempotent, formalActor, httpError, idempotencyKey, itemPayload, json, normalizeEmployeeDraft, receiptPayload, requireAuthorizedProject, requireItem, requireMembership, serializeEmployeeDraft } from "../../../_shared.js";

// PILOT-04/N1：流程卡必须包含"交给谁"(handoff) 与"大约耗时"(burden)。
// 这两个维度是报价依据与交接责任的来源，此前只存在于前端答案里，
// 既不进流程卡也不进事实，核验人完全看不到。
const CARD_FIELDS = ["trigger", "inputs", "steps", "judgments", "exceptions", "handoff", "burden", "materialIndex"];
// Formal writes use the Idempotency-Key request header so retries return the original result.

// ── PILOT-09C/IMPLEMENT-05A（F04）：服务端规范流程卡（canonical workflowCard） ──
// 事实来源必须是**服务端持久化的员工答案**；客户端提交的 workflowCard 只代表提交意图，
// 必须与服务端规范卡逐字段一致，否则拒绝提交（不能成为 candidate_facts 来源）。
// 七维 key/label 与前端 formalEmployeeQuestions、后端 QUESTION_BANK 保持一致。
const ANSWER_DIMENSIONS = [
  { key: "trigger", label: "从哪里开始" },
  { key: "inputs", label: "先看什么" },
  { key: "steps", label: "实际怎么做" },
  { key: "judgments", label: "哪些情况不能自己决定" },
  { key: "exceptions", label: "卡住后怎么办" },
  { key: "handoff", label: "交给谁" },
  { key: "burden", label: "大约多久" },
];
// 与前端 formal-ui-contract.js 的 employeeMaterialLabel 逐字一致（服务端派生，不接受客户端声明）。
const MATERIAL_INDEX_LABELS = {
  provided: "员工已说明有材料，等待登记",
  none_available: "目前没有可提供的材料",
  undecided: "尚未选择",
};
const normalizeAnswerText = (value) => String(value === undefined || value === null ? "" : value)
  .normalize("NFC")
  .replace(/\r\n/g, "\n")
  .trim();
const normalizeMaterialStatus = (value) => (["provided", "none_available", "undecided"].includes(value) ? value : "undecided");

/** 服务端规范卡：唯一输入 = 服务端持久化 answers + 服务端 materialStatus。 */
function buildCanonicalWorkflowCard(answers, materialStatus) {
  const normalizedAnswers = {};
  for (const { key } of ANSWER_DIMENSIONS) normalizedAnswers[key] = normalizeAnswerText(answers && answers[key]);
  const card = { ...normalizedAnswers, materialIndex: MATERIAL_INDEX_LABELS[normalizeMaterialStatus(materialStatus)] };
  const missing = ANSWER_DIMENSIONS.filter(({ key }) => !normalizedAnswers[key]).map(({ key }) => key);
  return { card, answers: normalizedAnswers, missing };
}

/** 服务端答案派生的规范提交文本（与前端 formalEmployeeQuestions 的拼接规则一致）。 */
function canonicalSubmissionText(answers) {
  return ANSWER_DIMENSIONS
    .map(({ key, label }) => `${label}：${normalizeAnswerText(answers && answers[key])}`)
    .join("\n\n");
}

/** 逐字段比较客户端卡片与服务端规范卡；返回不一致字段名（空数组 = 一致）。 */
function compareWorkflowCard(clientCard, canonicalCard) {
  const mismatchedFields = [];
  for (const key of CARD_FIELDS) {
    const expected = String(canonicalCard && canonicalCard[key] !== undefined ? canonicalCard[key] : "").trim();
    const actual = normalizeAnswerText(clientCard && clientCard[key]);
    if (actual !== expected) mismatchedFields.push(key);
  }
  return mismatchedFields;
}

/** SHA-256（用于审计快照的规范化摘要；不采用客户端自报哈希）。 */
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// ── PILOT-09C/FIX-CODEX-03A（R03-01/02）：提交载荷指纹与草稿版本读取 ──────────
// 用途：
//   · 版本绑定：正常提交与等待核验人分支都必须校验客户端声明的 baseRevision；
//   · 幂等区分：同一 Idempotency-Key / 同一文本但**完整载荷**（流程卡/材料/判定）不同时，
//     不得被当作同一次提交；
//   · 规范化 JSON：按键排序，避免对象键顺序不同被误判为不同载荷。
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};
const submissionRequestDigest = (payload) => {
  const serialized = canonicalJson(payload);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `SUB-${(hash >>> 0).toString(36).padStart(7, "0")}`;
};
const itemDraftRevisionOf = (item) => {
  try {
    const draft = item && item.employee_draft_json ? JSON.parse(item.employee_draft_json) : {};
    return Number.isInteger(draft.revision) && draft.revision >= 0 ? draft.revision : 0;
  } catch (_error) {
    return 0;
  }
};
// V0.1-01b: the high-impact categories must cover everything the shared contract
// requires — 金额 (amount), 工时 (labour hours), 成本 (cost), 岗位调整 (role or
// headcount change) and 合规 (compliance). The previous pattern omitted 工时/成本/
// 岗位调整, which are precisely the facts a short-video automation diagnosis rests
// on and the ones that underpin the quotation. Keep this list identical to the one
// in verification.js so classification cannot drift between creation and review.
const HIGH_IMPACT_TOPICS = /customer\s*ownership|归属|amount|金额|approval\s*responsibility|审批责任|compliance|合规|major\s*risk|重大风险|工时|用时|耗时|人力|人工投入|成本|费用|报价|预算|岗位|职责调整|人员调整/i;
const classifyImpactLevel = (claim) => HIGH_IMPACT_TOPICS.test(String(claim || "")) ? "high" : "normal";

function candidateFactsFromWorkflowCard(card, item, flowCardVersion) {
  const clean = (value) => Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean).join("；") : String(value || "").trim();
  const candidateFacts = [
      // ── PILOT-04B/B：事实必须按"可独立判断的来源"拆分 ──────────────────
      // 旧实现把 steps+judgments+burden 合成一条事实，后果：
      //   ① 核验人的一次判断同时定夺三件不同的事；
      //   ② 只要合并文本里出现"耗时/人力"，整条被判 high → steps/judgments
      //      被一并升级为双人核验（过度升级）；
      //   ③ 某个字段缺证据时，整条事实只能一起判"证据不足"，
      //      同条中本来可核实的字段被连带卡住（错误认定）。
      // 现按字段边界拆分，使每条事实的 sourceField 唯一、影响等级独立。
      { factType: "trigger_input", sourceField: "trigger", claim: `从哪里开始：${clean(card.trigger)}` },
      { factType: "trigger_input", sourceField: "inputs", claim: `先看什么：${clean(card.inputs)}` },
      { factType: "execution_judgment", sourceField: "steps,judgments", claim: `执行与判断：${clean(card.steps)}；${clean(card.judgments)}` },
      { factType: "effort_estimate", sourceField: "burden", claim: `耗时与人力：${clean(card.burden)}` },
      { factType: "exception_handoff", sourceField: "exceptions,handoff,materialIndex", claim: `异常与交接：${clean(card.exceptions)}；交给谁：${clean(card.handoff)}；${clean(card.materialIndex)}` },
  ].map((fact) => ({
    id: `FACT-${crypto.randomUUID()}`, projectId: item.project_id, workItemId: item.id,
    ...fact, required: true, impactLevel: classifyImpactLevel(fact.claim), secondConfirmationStatus: classifyImpactLevel(fact.claim) === "high" ? "pending" : "not_required",
    materialStatus: "unverified", status: "open", flowCardVersion,
  }));
  if (candidateFacts.length < 2 || candidateFacts.length > 5) throw httpError("每张流程卡必须生成 2 至 5 个候选事实", 500);
  return candidateFacts;
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    // R2A F1: readiness before the first business-table query.
    await assertSchemaReady(env.DB);
    const item = await requireItem(env.DB, params.itemId);
    const formal = item.project_id.startsWith("PRJ-");
    const current = formal ? await formalActor(request, env.DB) : demoActor(request);
    if (formal) {
      await requireMembership(env.DB, item.project_id, current, ["employee"]);
      await requireAuthorizedProject(env.DB, item.project_id);
      // 归属守卫先于幂等查询：成功提交后任务已转交核验人，原员工的重放请求
      // 以 403 拒绝（既有回归契约要求；比“返回旧响应”更严格，且不会产生新写入）。
      if (item.assignee_account_id !== current.accountId) return httpError("不能提交其他员工的摸排任务", 403);
    } else if (request.headers.get("Authorization")) return httpError("正式项目需要正式登录会话", 401);
    if (current.role !== "employee") return httpError("只有一线员工可以提交流程描述", 403);
    const body = await request.json().catch(() => ({}));
    const text = String(body.text || "").trim();
    if (!text || text.length > 4000) return httpError("流程描述不能为空且不能超过 4000 个字符", 422);
    const materialStatus = ["provided", "none_available", "undecided"].includes(body.materialStatus) ? body.materialStatus : "undecided";
    const key = idempotencyKey(request);
    if (formal && !key) return httpError("正式提交需要 Idempotency-Key", 422);
    // ── PILOT-09C/FIX-CODEX-03A（R03-01）：提交必须显式声明所依据的草稿版本 ─────
    // 缺失/非法 baseRevision 一律 fail-closed；绝不用服务端当前 revision 自动补齐。
    const baseRevision = body.baseRevision;
    if (formal && (!Number.isInteger(baseRevision) || baseRevision < 0)) {
      return json({
        code: "base_revision_required",
        detail: "提交必须携带你所依据的草稿 baseRevision（非负整数）；缺失或非法版本不会被自动补齐。请刷新页面后重试。",
        currentRevision: itemDraftRevisionOf(item),
      }, 428);
    }
    const requestDigest = formal ? submissionRequestDigest({
      text,
      materialStatus,
      workflowCard: body.workflowCard || {},
      inferences: Array.isArray(body.inferences) ? body.inferences : [],
      inferenceVerdicts: body.inferenceVerdicts || {},
      baseRevision,
    }) : null;
    const previous = formal ? await findIdempotent(env.DB, current, item.project_id, "employee-submission", key) : null;
    if (previous) {
      // 完整载荷不同的同一 Idempotency-Key 不得静默返回旧响应（否则卡片/材料/判定变化会被吞掉）。
      if (previous.requestDigest && requestDigest && previous.requestDigest !== requestDigest) {
        return json({
          code: "idempotency_key_reuse",
          detail: "同一 Idempotency-Key 被用于不同的提交内容，本次未写入。请使用新的请求键重试。",
          currentRevision: itemDraftRevisionOf(item),
        }, 409);
      }
      const replay = { ...previous };
      delete replay.requestDigest;
      return json(replay);
    }
    if (formal && materialStatus === "undecided") return httpError("提交前请选择材料状态", 422);
    if (item.stage !== "mapping" || item.status === "complete") return httpError("当前任务不接受员工流程描述", 409);
    // 旧版本提交：在产生任何写入之前明确拒绝，且不修改 employee_description /
    // workflow_card_json / material_status / employee_draft_json / 任何提交状态。
    const currentItemRevision = itemDraftRevisionOf(item);
    if (formal && baseRevision !== currentItemRevision) {
      return json({
        code: "submission_conflict",
        reason: "stale_base_revision",
        detail: "提交依据的草稿版本已过期（或任务已在别处更新），本次提交未写入。请刷新后重新确认流程卡与材料再提交。",
        currentRevision: currentItemRevision,
        expectedRevision: baseRevision,
      }, 409);
    }
    // ── PILOT-09C/IMPLEMENT-05A（F04）：正式提交只承认服务端规范卡 ──────────
    // 身份/归属/阶段/baseRevision 全部通过后，用**服务端持久化草稿答案**派生规范卡与规范文本；
    // 客户端卡片/文本仅代表提交意图，逐字段与服务端规范值比较，不一致则拒绝（零写入）。
    // candidate_facts 之后只能由 canonicalSubmission.card 生成。
    let canonicalSubmission = null;
    if (formal) {
      let serverDraftRaw = {};
      try { serverDraftRaw = item.employee_draft_json ? JSON.parse(item.employee_draft_json) : {}; } catch (_error) { serverDraftRaw = {}; }
      const serverDraft = normalizeEmployeeDraft(serverDraftRaw);
      const serverMaterialStatus = normalizeMaterialStatus(item.material_status);
      const built = buildCanonicalWorkflowCard(serverDraft.answers, serverMaterialStatus);
      if (built.missing.length) {
        return json({
          code: "answers_incomplete",
          detail: `服务端缺少 ${built.missing.length} 个维度的员工答案，不能提交（客户端卡片不能替代服务端答案）。请先保存完整答案后再试。`,
          missingDimensions: built.missing,
          currentRevision: currentItemRevision,
        }, 422);
      }
      if (materialStatus !== serverMaterialStatus) {
        return json({
          code: "material_status_conflict",
          detail: "提交的材料状态与服务端已保存的材料状态不一致，本次未写入。请刷新后重新确认材料状态。",
          currentRevision: currentItemRevision,
          expectedMaterialStatus: serverMaterialStatus,
        }, 409);
      }
      const mismatchedFields = compareWorkflowCard(body.workflowCard || {}, built.card);
      if (mismatchedFields.length) {
        return json({
          code: "card_evidence_mismatch",
          detail: "提交的流程卡与服务端已保存的员工答案不一致，本次未写入。请按真实答案重新确认后再提交。",
          mismatchedFields,
          currentRevision: currentItemRevision,
        }, 422);
      }
      const serverText = canonicalSubmissionText(built.answers);
      if (normalizeAnswerText(text) !== serverText) {
        return json({
          code: "submission_text_mismatch",
          detail: "提交文本与服务端答案派生的文本不一致，本次未写入。请刷新后重新确认再提交。",
          currentRevision: currentItemRevision,
        }, 422);
      }
      canonicalSubmission = {
        card: built.card,
        answers: built.answers,
        text: serverText,
        materialStatus: serverMaterialStatus,
      };
      // ── PILOT-09C/IMPLEMENT-05B（F03）：正式提交证据一致性门禁 ────────────
      // 在 F04 规范卡门禁之后、任何写入之前，按**同一份服务端快照**校验：
      //   答案完整性 / answersDigest / 每维最新陈述 / 推断证据版本引用 /
      //   模板引用与答案一致 / 无访谈证据不得提交 / 无法验证的跨维度依赖不放行。
      // 旧裁决是否仍有效由下方既有 inferenceResult（resolveInferenceJudgment 已绑定
      // evidenceVersion）统一裁决：stale 不自动升级，计入缺失 ⇒ 422。
      const evidenceGate = await validateSubmissionEvidence({ draft: serverDraft, answers: built.answers, materialStatus: serverMaterialStatus });
      if (!evidenceGate.ok) {
        const payload = { code: evidenceGate.code, detail: evidenceGate.detail, currentRevision: currentItemRevision };
        if (Array.isArray(evidenceGate.missingDimensions)) payload.missingDimensions = evidenceGate.missingDimensions;
        if (Array.isArray(evidenceGate.dimensions)) payload.dimensions = evidenceGate.dimensions;
        if (Array.isArray(evidenceGate.inferenceIds)) payload.inferenceIds = evidenceGate.inferenceIds;
        if (evidenceGate.expectedRuleVersion !== undefined) payload.expectedRuleVersion = evidenceGate.expectedRuleVersion;
        if (evidenceGate.actualRuleVersion !== undefined) payload.actualRuleVersion = evidenceGate.actualRuleVersion;
        return json(payload, evidenceGate.status || 409);
      }
    }
    let assignedVerifierId = formal ? null : (item.assigned_verifier_id || "demo-verifier");
    let assignedVerifierName = formal ? null : "流程核验人员";
    if (formal) {
      const verifier = await env.DB.prepare("SELECT pm.account_id, a.name AS assigned_verifier_name FROM project_memberships pm JOIN invitations i ON i.accepted_account_id = pm.account_id AND i.project_id = pm.project_id AND i.role='verifier' JOIN accounts a ON a.id=pm.account_id WHERE pm.project_id=? AND pm.role='verifier' AND pm.status='active' AND i.status='accepted' ORDER BY pm.created_at LIMIT 1").bind(item.project_id).first();
      assignedVerifierId = verifier?.account_id || null;
      assignedVerifierName = verifier?.assigned_verifier_name || null;
    }
    if (!assignedVerifierId) {
      // ── PILOT-09C/FIX-CODEX-02B（F05）：等待核验人分支必须走版本化 CAS ─────
      // 旧实现用 updateItem（WHERE 仅 id）无条件把请求开始时读到的旧草稿快照写回，
      // 且 serializeEmployeeDraft 未传 revision ⇒ 被写成 0。后果：revision 由 N 归零、
      // 并发期间的新草稿被旧快照覆盖、过期 revision=0 请求重新可匹配（VERIFY-CODEX-01 F05）。
      //
      // 修复：
      //   · 以**数据库当前快照**（而不是请求开始时的 item）为唯一依据重建草稿；
      //   · revision 严格 N→N+1，绝不复位为 0；
      //   · 状态字段、employee_draft_json / body.workflowCard / materialStatus 与
      //     handoff_status 在同一条条件 UPDATE 中写入（CAS 绑定 stage/status/revision），
      //     并发草稿保存或重复提交只会得到明确 409，不会丢失更新；
      //   · 成功路径返回 verifier_not_ready（HTTP 409），冲突路径返回 submission_conflict（409）。
      const fresh = await requireItem(env.DB, params.itemId);
      let freshRawDraft = {};
      try { freshRawDraft = fresh.employee_draft_json ? JSON.parse(fresh.employee_draft_json) : {}; } catch (_error) { freshRawDraft = {}; }
      const freshDraft = normalizeEmployeeDraft(freshRawDraft);
      const currentDraftRevision = freshDraft.revision;
      // R03-01（准备阶段，不写库）：先按数据库最新快照构造本次等待态提交的完整补丁，
      // 再由下面的版本/核验人/幂等判定决定是否真正执行 CAS 写入。
      // 这样任何早退路径都不需要修改 employee_description / workflow_card_json /
      // material_status / employee_draft_json 等字段。
      const nextRevision = currentDraftRevision + 1;
      const nextDraftJson = serializeEmployeeDraft({
        answers: freshDraft.answers,
        ledger: freshDraft.ledger,
        inferenceVerdicts: freshDraft.inferenceVerdicts,
        submissionText: text,
        revision: nextRevision,
      });
      const blockedPatch = {
        stage: "mapping",
        status: "blocked_draft",
        employee_draft_json: nextDraftJson,
        workflow_card_json: canonicalJson(body.workflowCard || {}),
        material_status: materialStatus,
        handoff_status: "waiting_assignment",
        blocking_reason: "项目核验人尚未接受邀请",
        next_action: "等待核验人加入后重新提交",
      };
      // R03-01：等待态提交同样必须绑定客户端所见版本；过期请求不得写回任何字段。
      if (formal && baseRevision !== currentDraftRevision) {
        return json({
          code: "submission_conflict",
          reason: "stale_base_revision",
          detail: "提交依据的草稿版本已过期，本次等待态提交未写入。请刷新后重新确认流程卡与材料再提交。",
          currentRevision: currentDraftRevision,
          expectedRevision: baseRevision,
          task: itemPayload(fresh),
          receipt: receiptPayload(fresh),
        }, 409);
      }
      // ── PILOT-09C/IMPLEMENT-05A（F04）：等待核验人分支同样只承认服务端规范卡 ──
      // 该分支会写入 workflow_card_json / material_status / submissionText，因此必须用
      // **数据库最新快照的 answers + materialStatus** 重新派生规范卡并逐字段/逐文本校验；
      // 客户端伪造卡片或矛盾文本一律拒绝，且不写任何字段（不得先保存后校）。
      let blockedCard = body.workflowCard || {};
      let blockedText = text;
      let blockedMaterialStatus = materialStatus;
      if (formal) {
        const freshBuilt = buildCanonicalWorkflowCard(freshDraft.answers, fresh.material_status);
        if (freshBuilt.missing.length) {
          return json({
            code: "answers_incomplete",
            detail: `服务端缺少 ${freshBuilt.missing.length} 个维度的员工答案，本次等待态提交未写入。`,
            missingDimensions: freshBuilt.missing,
            currentRevision: currentDraftRevision,
          }, 422);
        }
        const freshMaterialStatus = normalizeMaterialStatus(fresh.material_status);
        if (materialStatus !== freshMaterialStatus) {
          return json({
            code: "material_status_conflict",
            detail: "提交的材料状态与服务端已保存的材料状态不一致，本次等待态提交未写入。请刷新后重新确认材料状态。",
            currentRevision: currentDraftRevision,
            expectedMaterialStatus: freshMaterialStatus,
          }, 409);
        }
        const blockedMismatch = compareWorkflowCard(body.workflowCard || {}, freshBuilt.card);
        if (blockedMismatch.length) {
          return json({
            code: "card_evidence_mismatch",
            detail: "提交的流程卡与服务端已保存的员工答案不一致，本次等待态提交未写入。请按真实答案重新确认后再提交。",
            mismatchedFields: blockedMismatch,
            currentRevision: currentDraftRevision,
          }, 422);
        }
        const freshText = canonicalSubmissionText(freshBuilt.answers);
        if (normalizeAnswerText(text) !== freshText) {
          return json({
            code: "submission_text_mismatch",
            detail: "提交文本与服务端答案派生的文本不一致，本次等待态提交未写入。请刷新后重新确认再提交。",
            currentRevision: currentDraftRevision,
          }, 422);
        }
        // ── F03：等待核验人分支同样不得绕过证据一致性门禁（不写任何内容）──
        const blockedEvidenceGate = await validateSubmissionEvidence({ draft: freshDraft, answers: freshBuilt.answers, materialStatus: freshMaterialStatus });
        if (!blockedEvidenceGate.ok) {
          const payload = { code: blockedEvidenceGate.code, detail: blockedEvidenceGate.detail, currentRevision: currentDraftRevision };
          if (Array.isArray(blockedEvidenceGate.missingDimensions)) payload.missingDimensions = blockedEvidenceGate.missingDimensions;
          if (Array.isArray(blockedEvidenceGate.dimensions)) payload.dimensions = blockedEvidenceGate.dimensions;
          if (Array.isArray(blockedEvidenceGate.inferenceIds)) payload.inferenceIds = blockedEvidenceGate.inferenceIds;
          return json(payload, blockedEvidenceGate.status || 409);
        }
        blockedCard = freshBuilt.card;
        blockedText = freshText;
        blockedMaterialStatus = freshMaterialStatus;
        blockedPatch.workflow_card_json = canonicalJson(blockedCard);
        blockedPatch.material_status = blockedMaterialStatus;
        blockedPatch.employee_draft_json = serializeEmployeeDraft({
          answers: freshDraft.answers,
          ledger: freshDraft.ledger,
          inferenceVerdicts: freshDraft.inferenceVerdicts,
          submissionText: blockedText,
          revision: nextRevision,
        });
      }
      // R03-03：请求处理期间核验人可能已接受邀请。若已就绪，不写 blocked 状态，
      // 返回明确 409 让客户端刷新后走正常提交路径（避免“核验人已就绪却显示等待”）。
      const verifierNow = await env.DB.prepare("SELECT pm.account_id, a.name AS assigned_verifier_name FROM project_memberships pm JOIN invitations i ON i.accepted_account_id = pm.account_id AND i.project_id = pm.project_id AND i.role='verifier' JOIN accounts a ON a.id=pm.account_id WHERE pm.project_id=? AND pm.role='verifier' AND pm.status='active' AND i.status='accepted' ORDER BY pm.created_at LIMIT 1").bind(item.project_id).first();
      if (verifierNow?.account_id) {
        return json({
          code: "submission_conflict",
          reason: "verifier_ready",
          detail: "核验人已就绪，本次等待态提交未写入。请刷新后重新提交（将进入正常核验流程）。",
          currentRevision: currentDraftRevision,
          expectedRevision: baseRevision,
          task: itemPayload(fresh),
          receipt: receiptPayload(fresh),
        }, 409);
      }
      // R03-02：幂等判断必须比较**完整提交载荷**（文本 + 流程卡 + 材料状态），
      // 不能只看文本；否则同一文本但卡片/材料已变的请求会被静默丢弃。
      const storedCard = (() => { try { return JSON.parse(fresh.workflow_card_json || "{}"); } catch (_error) { return {}; } })();
      const alreadyBlocked = fresh.status === "blocked_draft" && fresh.handoff_status === "waiting_assignment"
        && String(fresh.employee_description || "") === blockedText
        && freshDraft.submissionText === blockedText
        && canonicalJson(storedCard) === canonicalJson(blockedCard)
        && fresh.material_status === blockedMaterialStatus;
      let blockedDraft = fresh;
      if (!alreadyBlocked) {
        const cas = await env.DB.prepare(
          `UPDATE work_items
              SET stage=?, status=?, assignee_role='employee', assignee_label=?,
                  assignee_account_id=?, source_employee_account_id=?, assigned_verifier_id=NULL,
                  employee_description=?, employee_draft_json=?, material_status=?, workflow_card_json=?,
                  blocking_reason=?, next_action=?, handoff_status=?
            WHERE id=? AND stage='mapping' AND status!='complete'
              AND assignee_account_id=? AND assigned_verifier_id IS NULL
              AND assignment_version=?
              AND COALESCE(json_extract(employee_draft_json,'$.revision'),0)=?`,
        ).bind(
          blockedPatch.stage, blockedPatch.status, fresh.assignee_label,
          current.accountId, current.accountId, blockedText,
          blockedPatch.employee_draft_json, blockedPatch.material_status, blockedPatch.workflow_card_json,
          blockedPatch.blocking_reason, blockedPatch.next_action, blockedPatch.handoff_status,
          params.itemId, current.accountId, Number(fresh.assignment_version || 1), currentDraftRevision,
        ).run();
        if (Number(cas?.meta?.changes || 0) !== 1) {
          // 并发保存/重复提交：明确冲突，绝不覆盖较新草稿。
          const latest = await requireItem(env.DB, params.itemId);
          return json({
            code: "submission_conflict",
            detail: "草稿已被其他请求更新，本次等待态提交未写入。请刷新后重试。",
            task: itemPayload(latest),
            receipt: receiptPayload(latest),
          }, 409);
        }
        blockedDraft = await requireItem(env.DB, params.itemId);
      }
      return json({ code: "verifier_not_ready", detail: "项目核验人尚未就绪，完整草稿已保存。", task: itemPayload(blockedDraft), receipt: receiptPayload(blockedDraft) }, 409);
    }
    const submittedAt = new Date().toISOString();
    const submissionVersion = Number(item.submission_version || 0) + 1;
    const transitionKey = crypto.randomUUID();
    const candidateFacts = candidateFactsFromWorkflowCard(formal ? canonicalSubmission.card : (body.workflowCard || {}), item, Number(item.flow_card_version || 1));
    // PILOT-04/D7：把员工对 AI 推断的逐条判定连同推断原文一并持久化。
    // 此前只存在前端内存里 —— 员工说"不对，我改"之后，核验人永远看不到这句否认。
    // 复用既有列 alternative_explanations_json（_shared.js 早已实现读取），零迁移。
    // ── PILOT-08E/D1：以**服务端推断基线**为唯一可信来源 ────────────────
    // 基线由 employee-turn 在签发锚点的同一次 CAS 中写入。
    let submissionDraft = {};
    try { submissionDraft = item.employee_draft_json ? JSON.parse(item.employee_draft_json) : {}; } catch (_error) { submissionDraft = {}; }
    const submissionNormalized = normalizeEmployeeDraft(submissionDraft);
    const submissionLedger = submissionNormalized.ledger;
    const baselineInferences = submissionLedger && Array.isArray(submissionLedger.authoritativeInferences)
      ? submissionLedger.authoritativeInferences : [];
    // ── PILOT-09C/IMPLEMENT-2B（F2）：判定来源必须是**库中持久化草稿** ────────
    // 为什么不信 `body.inferenceVerdicts`：
    //   · 版本盖章（contentVersion/templateVersion/evidenceHash）只能由服务端根据
    //     **库中条目**计算，客户端载荷无法证明"员工确认的是哪一个版本"；
    //   · 客户端可在未保存的情况下直接提交，从而把"未落库的判定"当作已完成；
    //   · 客户端可伪造版本字段来让旧判定重新生效。
    // 因此：唯一可信判定 = 本任务草稿里已由 employee-draft 盖章保存的 inferenceVerdicts。
    const trustedVerdicts = submissionNormalized.inferenceVerdicts && typeof submissionNormalized.inferenceVerdicts === "object"
      ? submissionNormalized.inferenceVerdicts : {};
    const submissionDraftRevision = Number.isInteger(submissionNormalized.revision) ? submissionNormalized.revision : 0;
    const inferenceResult = buildPersistedInferences(body, current.accountId, baselineInferences, trustedVerdicts);
    const persistedInferences = inferenceResult.rows;
    // ── PILOT-09C/IMPLEMENT-2：提交守卫（覆盖**完整记录集**，不只是可见的 12 条）──
    // ① 溢出但**仍需判定**的推断：员工在界面上看不到、无法处理 ⇒ 必须阻止提交并说明原因，
    //    不得让它们悄悄绕过门禁。
    if (baselineInferences.length && inferenceResult.overflowPending.length) {
      return httpError(
        `有 ${inferenceResult.overflowPending.length} 条 AI 推断因容量限制未进入判定列表，但尚未完成判定。请联系项目管理员处理后再提交（不会丢弃你的历史判定）。`,
        422,
        "inferences_overflow_pending",
      );
    }
    // ② 其余未完成判定（含 stale：证据版本已变化、旧判定不再适用）→ 沿用既有错误语义。
    if (baselineInferences.length && inferenceResult.missingJudgements.length) {
      return httpError(`还有 ${inferenceResult.missingJudgements.length} 条 AI 推断没有判定，请先逐条确认或更正。`, 422, "inferences_unjudged");
    }
    // ── PILOT-08E/D1：没有服务端推断基线时的安全兼容 ────────────────────
    // 正式链路里，基线由 employee-turn 在签发锚点时落库；因此**有推断要判定**
    // 的任务必然存在基线。基线为空只有两种可能：
    //   ① 该任务从未经过自主访谈（例如直接由 API 构造的历史/测试任务）；
    //   ② 客户端在本轮之前就已经提交过（此时客户端仍可能带着自己的推断列表）。
    // 无论哪种，服务端都**没有**可信的推断原文可写。按报告 §八：
    // 「不得默认信任旧客户端载荷」「无法安全兼容时：明确返回可恢复错误」。
    // 因此这里拒绝，并给出可恢复错误码，而不是静默丢弃员工判定。
    // 演示身份（非 formal）不施加该限制，以免影响演示路径与离线回归。
    const submittedInferences = Array.isArray(body.inferences) ? body.inferences.filter((entry) => entry && entry.id && entry.text) : [];
    if (formal && !baselineInferences.length && submittedInferences.length) {
      return httpError(
        "服务端没有这次访谈的推断基线，无法确认你判定的是哪些 AI 推断。请重新打开任务并完成一轮访谈后重试。",
        409,
        "inference_baseline_missing",
      );
    }
    const changes = { stage: "facts", status: "awaiting_verification", assignee_role: "verifier", assignee_label: "流程核验人员", assignee_account_id: assignedVerifierId, source_employee_account_id: formal ? current.accountId : item.source_employee_account_id, assigned_verifier_id: assignedVerifierId, submission_version: submissionVersion, submitted_at: submittedAt, handoff_status: "assigned", last_submission_key: transitionKey, evidence_completeness: 65, blocking_reason: "等待核验员工描述与佐证材料", next_action: "核验员工描述", employee_description: canonicalSubmission ? canonicalSubmission.text : text, material_status: canonicalSubmission ? canonicalSubmission.materialStatus : materialStatus, workflow_card_json: canonicalSubmission ? JSON.stringify(canonicalSubmission.card) : JSON.stringify(body.workflowCard || {}), alternative_explanations_json: JSON.stringify(persistedInferences) };
    const actorId = current.userId || current.accountId;
    // ── PILOT-09C/IMPLEMENT-3F：正式提交的**独立审计快照** ──────────────
    // 问题（DESIGN-3E / E11）：submission_version 递增，但旧提交的推断与判定内容
    // 只存在 alternative_explanations_json（单列，每次覆盖）⇒ 旧版本无法独立追溯。
    // 方案：把**服务端可信状态**快照写入 employee_submitted 事件载荷（零迁移）。
    //   · 数据源 = persistedInferences（由库中基线与草稿判定生成，客户端不可影响）；
    //   · 与该次 submissionVersion 严格对应；
    //   · 与状态更新在同一次 env.DB.batch() 中提交（D1 batch 为单事务）；
    //   · 事件 INSERT 带 `last_submission_key=transitionKey` 守卫 —— 状态更新失败则事件
    //     不会写入，因此**不存在"事件成功但提交失败"或"提交成功但无快照"**。
    const submissionHistory = submissionLedger && Array.isArray(submissionLedger.statementHistory)
      ? submissionLedger.statementHistory : [];
    const submissionEvidence = submissionEvidenceSummary(submissionNormalized);
    const statementHistorySeq = submissionHistory.reduce(
      (max, entry) => Math.max(max, Number.isInteger(entry && entry.seq) ? entry.seq : 0), 0);
    // ── PILOT-09C/FIX-IMPLEMENT-05A（F04）：审计快照记录**服务端可信来源** ──
    // 摘要全部由服务端对该快照的 answers/canonical card 重新计算（SHA-256），
    // 不采信客户端自报哈希；demo（非正式）路径保持既有行为并显式标记来源。
    const auditAnswers = canonicalSubmission ? canonicalSubmission.answers : null;
    const auditCard = canonicalSubmission ? canonicalSubmission.card : null;
    const answersDigest = auditAnswers ? await sha256Hex(canonicalJson(auditAnswers)) : null;
    const workflowCardDigest = auditCard ? await sha256Hex(canonicalJson(auditCard)) : null;
    const submittedPayload = {
      text: canonicalSubmission ? canonicalSubmission.text : text,
      workflowCard: canonicalSubmission ? canonicalSubmission.card : (body.workflowCard || {}),
      materialStatus: canonicalSubmission ? canonicalSubmission.materialStatus : materialStatus,
      idempotencyKey: key || null,
      // ── 审计快照（服务端生成，客户端字段一律不采信）──
      submissionVersion,
      workItemId: params.itemId,
      projectId: item.project_id,
      submittedAt,
      source: "server_employee_submission",
      // 每条含 id / 原文 / quote / evidenceHash / contentVersion / templateVersion /
      // source / listed / judgmentState / verdict / correction / history
      inferences: persistedInferences,
      // 判定投影（便于审计按版本核对，字段与 inferences 同源）
      verdicts: persistedInferences.map((row) => ({
        id: row.id,
        verdict: row.verdict,
        correction: row.correction,
        contentVersion: row.contentVersion,
        templateVersion: row.templateVersion,
        evidenceHash: row.evidenceHash,
        judgmentState: row.judgmentState,
      })),
      // 本次提交时陈述历史的边界（seq 上界 + 条数）—— 仅边界，不复制全文
      statementHistorySeq,
      statementHistoryCount: submissionHistory.length,
      // ── F03：证据版本快照（服务端派生；旧裁决是否有效必须能按版本追溯）──
      evidenceSeq: submissionEvidence.evidenceSeq,
      evidenceAnswersDigest: submissionEvidence.answersDigest,
      evidenceDimensions: submissionEvidence.dimensions,
      evidenceHistorySeq: submissionEvidence.historySeq,
      // FIX-06A：显式证据来源（服务端维护）：区分"旧数据受控初始化"与"真实访谈"
      evidenceSource: submissionEvidence.source,
      evidenceLegacyInitialized: submissionEvidence.legacyInitialized,
      evidenceInitialHistoryEntries: submissionEvidence.initialHistoryCount,
      // ── G14：提交快照标记服务端依赖规则版本与依赖审计概况（完整可复核）──
      evidenceRuleVersion: submissionEvidence.ruleVersion,
      inferenceDependencyRuleVersions: submissionEvidence.inferenceDependencyRuleVersions,
      invalidationAuditCount: submissionEvidence.invalidationAuditCount,
      draftRevision: submissionDraftRevision,
      // ── F04 可信来源（新增，向后兼容；旧消费者忽略未知字段）──
      answersDigest,
      answersCount: auditAnswers ? ANSWER_DIMENSIONS.filter(({ key }) => Boolean(auditAnswers[key])).length : null,
      canonicalWorkflowCard: auditCard,
      workflowCardDigest,
      cardSource: canonicalSubmission ? "server_canonical" : "client_payload_demo",
      submissionSchemaVersion: 2,
    };
    const handoffPayload = { fromRole: "employee", toRole: "verifier", receiverId: assignedVerifierId, receiverName: assignedVerifierName, targetStage: "facts", state: "assigned", submissionVersion };
    const persisted = { ...item, ...changes, assigned_verifier_name: assignedVerifierName };
    const response = { item: itemPayload(persisted), receipt: receiptPayload(persisted), candidateFacts };
    const statements = [
      // PILOT-09C/IMPLEMENT-2B：额外把**草稿 revision** 纳入 CAS 条件。
      // 判定是对"某一个具体版本"的确认，而基线与判定同处草稿；若在本次读取之后
      // 有并发轮次推进了草稿（基线/证据版本随之变化），则这次提交所依据的快照已过期 ⇒
      // UPDATE 影响 0 行 ⇒ 后续 last_submission_key 校验失败 ⇒ 返回 409 让客户端刷新重判。
      // 这样"并发更新造成版本错配"在数据库层被直接挡住，而不是靠时序侥幸。
      env.DB.prepare("UPDATE work_items SET stage=?,status=?,assignee_role=?,assignee_label=?,assignee_account_id=?,source_employee_account_id=?,assigned_verifier_id=?,submission_version=?,submitted_at=?,handoff_status=?,last_submission_key=?,evidence_completeness=?,blocking_reason=?,next_action=?,employee_description=?,material_status=?,workflow_card_json=?,alternative_explanations_json=? WHERE id=? AND stage=? AND status=? AND submission_version=? AND COALESCE(json_extract(employee_draft_json,'$.revision'),0)=? AND COALESCE(assigned_verifier_id,'')=? AND assignment_version=? AND EXISTS (SELECT 1 FROM project_memberships pm_guard WHERE pm_guard.project_id=work_items.project_id AND pm_guard.account_id=? AND pm_guard.role='verifier' AND pm_guard.status='active')")
        .bind(changes.stage, changes.status, changes.assignee_role, changes.assignee_label, changes.assignee_account_id, changes.source_employee_account_id, changes.assigned_verifier_id, changes.submission_version, changes.submitted_at, changes.handoff_status, transitionKey, changes.evidence_completeness, changes.blocking_reason, changes.next_action, changes.employee_description, changes.material_status, changes.workflow_card_json, changes.alternative_explanations_json, params.itemId, item.stage, item.status, Number(item.submission_version || 0), submissionDraftRevision, String(item.assigned_verifier_id || ""), Number(item.assignment_version || 1), assignedVerifierId),
      env.DB.prepare("INSERT INTO events (event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,?,?,?,?,?,? FROM work_items WHERE id=? AND last_submission_key=?").bind(`EVT-${crypto.randomUUID()}`, item.project_id, params.itemId, "employee_submitted", current.role, actorId, JSON.stringify(submittedPayload), params.itemId, transitionKey),
      env.DB.prepare("INSERT INTO events (event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,?,?,?,?,?,? FROM work_items WHERE id=? AND last_submission_key=?").bind(`EVT-${crypto.randomUUID()}`, item.project_id, params.itemId, "handoff", current.role, actorId, JSON.stringify(handoffPayload), params.itemId, transitionKey),
    ];
    for (const fact of candidateFacts) statements.push(
      env.DB.prepare("INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,flow_card_version,evidence_version) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? FROM work_items WHERE id=? AND last_submission_key=?")
        .bind(fact.id, fact.projectId, fact.workItemId, fact.factType, fact.claim, fact.sourceField, 1, fact.impactLevel, fact.secondConfirmationStatus, fact.materialStatus, fact.status, fact.flowCardVersion, Number(item.evidence_version || 1), params.itemId, transitionKey)
    );
    if (formal) statements.push(env.DB.prepare("INSERT INTO idempotency_records(account_id,project_id,action,request_key,response_json) SELECT ?,?,?,?,? FROM work_items WHERE id=? AND last_submission_key=?").bind(current.accountId, item.project_id, "employee-submission", key, JSON.stringify({ ...response, requestDigest }), params.itemId, transitionKey));
    await env.DB.batch(statements);
    const updated = await env.DB.prepare("SELECT wi.*, verifier.name AS assigned_verifier_name FROM work_items wi LEFT JOIN accounts verifier ON verifier.id=wi.assigned_verifier_id WHERE wi.id=?").bind(params.itemId).first();
    if (updated.last_submission_key !== transitionKey) return json({ code: "submission_conflict", detail: "任务已由另一请求提交，请刷新后查看最新状态。", task: itemPayload(updated), receipt: receiptPayload(updated) }, 409);
    response.item = itemPayload(updated);
    response.receipt = receiptPayload(updated);
    return json(response);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}

/**
 * 归一化"AI 推断 + 员工判定"，准备写入 alternative_explanations_json。
 *
 * 结构：[{ id, text, basis, assumes, verdict, correction }]
 *   verdict: "confirm"（员工认可）| "correct"（员工否认并给出更正）
 *
 * 安全要点：**员工否认的推断绝不能被下游当作已确认事实**。这里只做存储，
 * 事实的最终认定仍在 verification.js（核验人）。核验人看到的是一条带
 * verdict/correction 的推断，而不是一条事实。
 */
function buildPersistedInferences(body, accountId, baseline = [], trustedVerdicts = {}) {
  // PILOT-08E/D1：**推断原文只取自服务端基线**（baseline）。
  // 客户端提交的 body.inferences[].text 一律不再采信 —— 员工只能通过
  // inferenceVerdicts（按服务端推断 ID）贡献"判定 + 更正原文"。
  //
  // PILOT-09C/IMPLEMENT-2B（F2）：**判定也只取自库中持久化草稿**（trustedVerdicts）。
  //   · `body.inferenceVerdicts` 不再参与任何裁决（未保存的判定不算已完成）；
  //   · 版本绑定由 resolveInferenceJudgment 统一裁决：stale 与 unjudged 同等对待；
  //   · 落库字段扩展 quote / evidenceHash / contentVersion / templateVersion /
  //     listed / judgmentState / history，使核验人与审计能看到**证据来源与版本**；
  //   · `overflowPending` —— 记录集中**未列入可见列表**（`listed === false`）且仍需判定的推断。
  //     这类推断员工在界面上看不到、无法处理，因此必须**阻止提交**并说明原因，
  //     而不是让它们悄悄绕过门禁。
  //
  // 返回 { rows, missingJudgements, unknownVerdictIds, overflowPending }。
  const verdicts = trustedVerdicts && typeof trustedVerdicts === "object" && !Array.isArray(trustedVerdicts)
    ? trustedVerdicts : {};
  const baselineIds = new Set(baseline.map((entry) => entry && entry.id).filter(Boolean));
  const unknownVerdictIds = Object.keys(verdicts).filter((id) => !baselineIds.has(id));
  const rows = [];
  const missingJudgements = [];
  const overflowPending = [];
  for (const entry of baseline) {
    if (!entry || !entry.id || !entry.text) continue;
    const stamp = verdicts[entry.id] && typeof verdicts[entry.id] === "object" ? verdicts[entry.id] : {};
    // PILOT-07C/R2：与草稿写入共用同一套规范化（agree/confirm → confirmed）。
    const verdict = canonicalVerdict(stamp.verdict);
    const correction = typeof stamp.correction === "string" ? stamp.correction.trim().slice(0, 500) : "";
    const judgmentState = resolveInferenceJudgment(entry, verdicts);
    if (judgmentState !== "valid") {
      missingJudgements.push(entry.id);
      if (entry.listed === false) overflowPending.push(entry.id);
    }
    rows.push({
      id: entry.id,
      text: String(entry.text).slice(0, 500),   // ★ 服务端原文，客户端无法替换
      quote: entry.quote ? String(entry.quote).slice(0, 300) : null,   // ★ 证据来源
      basis: entry.basis ? String(entry.basis).slice(0, 120) : null,
      assumes: entry.assumes ? String(entry.assumes).slice(0, 300) : null,
      source: entry.source === "server_template" ? "server_template" : "model",
      evidenceHash: entry.evidenceHash || null,        // ★ 内容签名（服务端计算）
      contentVersion: Number.isInteger(entry.contentVersion) ? entry.contentVersion : null,   // ★ 内容版本
      templateVersion: Number.isInteger(entry.templateVersion) ? entry.templateVersion : null,
      listed: entry.listed !== false,                  // ★ 是否进入过员工可见列表
      judgmentState,                                   // ★ valid / stale / unjudged
      verdict,
      correction: correction || null,
      // ── G14：服务端依赖元数据/失效审计完整写入提交快照（不截断）─────────
      evidenceRefs: Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs : [],
      evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : null,
      dependencyRuleVersion: Number.isInteger(entry.dependencyRuleVersion) ? entry.dependencyRuleVersion : null,
      dependencySource: typeof entry.dependencySource === "string" ? entry.dependencySource : null,
      dependencyRuleStatus: typeof entry.dependencyRuleStatus === "string" ? entry.dependencyRuleStatus : null,
      dependencyProposalKey: typeof entry.dependencyProposalKey === "string" ? entry.dependencyProposalKey : null,
      proposedDependencyDimensions: Array.isArray(entry.proposedDependencyDimensions) ? entry.proposedDependencyDimensions : [],
      dependencyHintsRejected: Array.isArray(entry.dependencyHintsRejected) ? entry.dependencyHintsRejected : [],
      invalidations: Array.isArray(entry.invalidations) ? entry.invalidations : [],
      // ── FIX-07A（R07-F01）：判定变更审计历史必须**完整保留** ─────────────
      // 旧实现 slice(-10) 会在提交快照（alternative_explanations_json 与
      // employee_submitted payload.inferences）里静默丢弃较旧的历史，而草稿本身保留完整
      // 记录 —— 审计快照与源数据不一致。历史遗留数据可能已超过 10 条（FIX-06A 只限制
      // 新的判定变更写入），因此这里不截断、不静默删除；提交不追加历史，仅原样快照。
      history: Array.isArray(stamp.history) ? stamp.history : [],   // ★ 判定变更审计（完整保留）

      judgedByAccountId: judgmentState === "valid" ? accountId : null,
    });
    if (rows.length >= 40) break;   // 与 _adapter 的记录集上限一致（不再按可见列表的 12 截断）
  }
  return { rows, missingJudgements, unknownVerdictIds, overflowPending };
}
