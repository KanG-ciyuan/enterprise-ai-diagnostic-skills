/**
 * PILOT-09C/FIX-CODEX-02B —— F02 + F05 版本控制与并发一致性 · 定向运行时套件
 *
 * F02（旧页面覆盖新页面）：
 *   - 保存必须显式携带 baseRevision；缺失/非法一律 fail-closed（428），不得自动取当前版本；
 *   - 旧版本 → 409 draft_conflict，数据库不回退；未来版本 → 409；
 *   - 并发保存只有一个成功；失败请求不产生任何写入；
 *   - 前端静态契约：页面加载初始化真实 revision、api-client 透传 baseRevision、冲突闩锁。
 *
 * F05（核验人未就绪提交导致 revision 归零）：
 *   - 等待核验人分支以数据库当前快照做 CAS，revision N→N+1（绝不归零、不写回旧快照）；
 *   - 重复提交幂等；旧版本请求在提交前后均被拒绝；
 *   - 受控并发提交 + 保存：revision 单调、无静默丢失更新；
 *   - 核验人已就绪时正常提交保持可用；权威推断基线不被该分支改动（F01 回归）。
 *
 * 使用真实 handler + 内存 D1；不触网、不使用真实密钥。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { draftRevisionOf, normalizeEmployeeDraft, serializeEmployeeDraft } from "../functions/_shared.js";
import { ANSWER_DIMENSIONS as EVIDENCE_DIMENSIONS, canonicalJson as evidenceCanonicalJson, normalizeAnswers as evidenceNormalizeAnswers } from "../functions/api/agent/_evidence.js";
import { appendStatementHistory } from "../functions/api/agent/_adapter.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { buildInferenceRecords } from "../functions/api/agent/_adapter.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const P = "PRJ-B02TEST";
const ITEM = "WI-B02TEST";
const EMP = "ACC-B02-EMP";
const VER = "ACC-B02-VER";
const TOK = "TOK-B02-EMP";

/** 员工七维答案：既是夹具草稿 answers 的来源，也是提交规范卡/文本的来源。 */
const ANSWERS = {
  trigger: "每天早上运营同事在群里发来当天的推广需求，我看到消息后开始处理",
  inputs: "先看昨天的曝光和点击数据，再看库存数量，然后确认投放预算还剩多少",
  steps: "先选品再写脚本，然后让剪辑同事剪出来，最后在后台提交审核并发布",
  judgments: "毛利率低于一成要先找主管确认，其他价格我自己按历史数据定",
  exceptions: "版权不确定就换同款，审核被拒就先改文案再重新提交",
  handoff: "剪完的素材交给投放同事小李，由他挂车和设置出价",
  burden: "一条视频从选题到发布大约需要三个小时，一周做五条左右",
};
// ── PILOT-09C/IMPLEMENT-05A（F04）：正式提交必须使用服务端规范卡/规范文本 ──
// 服务端规范值 = 已持久化草稿 answers + work_items.material_status 派生；
// 客户端载荷不一致即拒绝（正常 422 card_evidence_mismatch / submission_text_mismatch，
// 等待核验人分支同样校验）。本套件因此让"夹具答案"与"提交载荷"同源。
const ANSWER_DIMENSIONS = [
  ["trigger", "从哪里开始"], ["inputs", "先看什么"], ["steps", "实际怎么做"],
  ["judgments", "哪些情况不能自己决定"], ["exceptions", "卡住后怎么办"],
  ["handoff", "交给谁"], ["burden", "大约多久"],
];
const MATERIAL_INDEX_LABELS = {
  provided: "员工已说明有材料，等待登记",
  none_available: "目前没有可提供的材料",
  undecided: "尚未选择",
};
const canonicalCard = (answers, materialStatus = "provided") => {
  const card = {};
  for (const [key] of ANSWER_DIMENSIONS) card[key] = String(answers[key] || "").trim();
  card.materialIndex = MATERIAL_INDEX_LABELS[materialStatus];
  return card;
};
const canonicalText = (answers) => ANSWER_DIMENSIONS.map(([key, label]) => `${label}：${String(answers[key] || "").trim()}`).join("\n\n");
const answersWithTrigger = (trigger) => ({ ...ANSWERS, trigger });

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });
const check = (id, name, ok, note = "") => (ok ? pass(id, name, note) : fail(id, name, note));

// ── PILOT-09C/IMPLEMENT-05B（F03）：服务端证据状态夹具 ───────────────────────
// F03 起正式提交要求 ledger.evidence / statementHistory 与答案一致，推断带
// evidenceVersion/evidenceRefs，判定回显 evidenceVersion。旧夹具只播种答案/推断。
// 这里用服务端构建函数生成与真实统一证据写入同构的状态（摘要用 node:crypto
// 按同一 SHA-256 算法独立计算），保持既有 revision/断言数值不变。
const evidenceSha256 = (value) => `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
const DEFAULT_INFERENCE_DEFS = [
  { source: "model", text: "F02/F05 基线推断 1：服务端权威记录（步骤）", basis: "steps", assumes: "若与实际不符需更正" },
  { source: "model", text: "F02/F05 基线推断 2：服务端权威记录（判断）", basis: "judgments", assumes: "若与实际不符需更正" },
];
function seedEvidenceState({ answers = {}, inferences = [], revision = 0, verdicts = null, defaultVerdict = "agree" }) {
  const normalized = evidenceNormalizeAnswers(answers);
  let history = [];
  for (const dimension of EVIDENCE_DIMENSIONS) {
    if (!normalized[dimension]) continue;
    history = appendStatementHistory({ prior: history, dimension, text: normalized[dimension], revision }).history;
  }
  const dimensions = {};
  for (const dimension of EVIDENCE_DIMENSIONS) {
    dimensions[dimension] = { digest: normalized[dimension] ? evidenceSha256(normalized[dimension]) : null, seq: normalized[dimension] ? 1 : 0 };
  }
  const evidence = {
    schemaVersion: 1, seq: history.length ? 1 : 0,
    answersDigest: evidenceSha256(evidenceCanonicalJson(normalized)),
    dimensions, revision, updatedAt: new Date().toISOString(),
    // PILOT-09C/G14：证据/依赖规则版本（提交门禁要求 === G14_RULE_VERSION=1）。
    ruleVersion: 1,
  };
  const seededInferences = inferences.map((entry) => {
    const basis = EVIDENCE_DIMENSIONS.includes(entry.basis) ? entry.basis : null;
    const isTemplate = entry.source === "server_template";
    const suppliedRefs = Array.isArray(entry.evidenceRefs)
      ? entry.evidenceRefs.filter((ref) => ref && EVIDENCE_DIMENSIONS.includes(ref.dimension)) : [];
    // PILOT-09C/G14：生成服务端同构的依赖元数据。模板固定依赖 basis；模型缺少建议时绑定全部已答维度。
    const refs = isTemplate
      ? (basis && dimensions[basis] && dimensions[basis].digest
        ? [{ dimension: basis, digest: dimensions[basis].digest, source: "server_template_fixed", ruleId: null }] : [])
      : (suppliedRefs.length
        ? suppliedRefs.map((ref) => ({
          dimension: ref.dimension,
          digest: dimensions[ref.dimension].digest,
          source: typeof ref.source === "string" ? ref.source : "basis",
          ruleId: ref.ruleId === undefined ? null : ref.ruleId,
        }))
        : (basis && dimensions[basis] && dimensions[basis].digest
          ? [{ dimension: basis, digest: dimensions[basis].digest, source: "basis", ruleId: null }] : []));
    // PILOT-09C/G14-FIX-CODEX-01（F03）：依赖提议指纹必须与当前 basis/proposedDependencyDimensions
    // 一致；保存时指纹缺失或不匹配会触发服务端重新裁决（EV++），使既有判定意外失效。
    const hintDimensions = suppliedRefs.length && !isTemplate
      ? [...new Set(suppliedRefs.filter((ref) => ref.dimension !== basis).map((ref) => ref.dimension))].sort()
      : [];
    return {
      ...entry,
      evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : 0,
      // FINAL-FIX-01: no model suggestion means conservative scope, never a fabricated basis-only rule.
      evidenceRefs: isTemplate ? refs : EVIDENCE_DIMENSIONS.filter((dim) => dimensions[dim]?.digest)
        .map((dimension) => ({ dimension, digest: dimensions[dimension].digest, source: "model_conservative_potential", ruleId: null })),
      dependencyRuleVersion: 1,
      dependencySource: isTemplate ? "server_template_fixed" : "model_conservative_potential",
      dependencyRuleStatus: isTemplate ? "server_template_fixed" : "model_conservative_potential",
      proposedDependencyDimensions: hintDimensions,
      dependencyHintsRejected: [],
      invalidations: Array.isArray(entry.invalidations) ? entry.invalidations : [],
      dependencyProposalKey: JSON.stringify({ basis: basis || null, hints: hintDimensions }),
    };
  });
  const seededVerdicts = {};
  for (const entry of seededInferences) {
    const supplied = verdicts && verdicts[entry.id] ? verdicts[entry.id] : null;
    if (!supplied && !defaultVerdict) continue;
    seededVerdicts[entry.id] = {
      verdict: supplied ? supplied.verdict : defaultVerdict,
      correction: supplied ? String(supplied.correction || "") : "",
      contentVersion: entry.contentVersion,
      templateVersion: entry.templateVersion === undefined ? null : entry.templateVersion,
      evidenceHash: entry.evidenceHash || null,
      evidenceVersion: entry.evidenceVersion,
    };
  }
  return { normalized, history, evidence, inferences: seededInferences, verdicts: seededVerdicts };
}

/**
 * 播种：project（mapping/needs_input）+ 员工任务 + 草稿。
 * opts.verifierReady / opts.revision / opts.answers / opts.records / opts.submissionText / opts.status
 */
function fixture(opts = {}) {
  const {
    verifierReady = false,
    revision = 0,
    answers = {},
    records = [],
    submissionText = "",
    status = "needs_input",
    includeBaseline = records.length > 0,
  } = opts;
  const db = new D1Harness();
  // F03：播种证据元数据/陈述历史/推断证据版本（无显式基线时用默认服务端基线，
  // 使等待态/正常提交在"有访谈证据"的前提下验证版本与 CAS 语义）。
  const baseRecords = records.length ? records : buildInferenceRecords([], DEFAULT_INFERENCE_DEFS).records;
  const evidenceSeed = seedEvidenceState({ answers, inferences: baseRecords, revision });
  const draft = serializeEmployeeDraft({
    answers,
    ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: evidenceSeed.evidence, authoritativeInferences: evidenceSeed.inferences, statementHistory: evidenceSeed.history, burdenAsked: false },
    inferenceVerdicts: evidenceSeed.verdicts,
    submissionText,
    revision,
  });
  const verifierInvitation = verifierReady
    ? `('INV-B02-VER','inv-b02-ver','${P}','${EMP}','ver@b02.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','IK-B02')`
    : `('INV-B02-VER','inv-b02-ver','${P}','${EMP}','ver@b02.invalid','verifier','project','pending','2099-01-01T00:00:00Z',NULL,'IK-B02')`;
  const verifierMembership = verifierReady
    ? `INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES ('${P}','${VER}','verifier','project','active');`
    : "";
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@b02.invalid','员工甲','active','member'),
      ('${VER}','ver@b02.invalid','核验人乙','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage)
      VALUES ('${P}','F02/F05 修复验证','选品到发布','mapping','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status)
      VALUES ('${P}','${EMP}','employee','project','active');
    ${verifierMembership}
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-B02','${P}','授权','王总','o@b02.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key)
      VALUES ${verifierInvitation};
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version)
      VALUES ('${ITEM}','${P}','还原工作','d','mapping','${status}','employee','员工甲',0,'b','n','${EMP}',${verifierReady ? `'${VER}'` : "NULL"},'${draft.replace(/'/g, "''")}','provided',1,1);
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token)
      VALUES ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R-B02');
  `);
  return db;
}

const readDraft = (db) => normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
const revisionOf = (db) => draftRevisionOf(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
const baselineOf = (db) => readDraft(db).ledger?.authoritativeInferences || [];

const put = (db, body) => saveDraft({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, TOK, body),
  env: { DB: db }, params: { itemId: ITEM },
});
const submit = (db, body, key = "K-B02") => submitEmployee({
  // PILOT-09C/FIX-CODEX-03A：正式提交现在必须携带 baseRevision（测试按库中当前版本补齐）。
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK, { ...body, baseRevision: Number.isInteger(body.baseRevision) ? body.baseRevision : revisionOf(db) }, { "Idempotency-Key": key }),
  env: { DB: db }, params: { itemId: ITEM },
});
const jsonOf = async (response) => response.clone().json().catch(() => ({}));
const submissionBody = (answers = ANSWERS, extra = {}) => ({ text: canonicalText(answers), workflowCard: canonicalCard(answers, "provided"), materialStatus: "provided", inferences: [], inferenceVerdicts: {}, ...extra });

console.log("PILOT-09C/FIX-CODEX-02B · F02 + F05 版本控制与并发一致性 —— 定向运行时套件\n");

// ═══════════════════════════════════════════════════════════════
console.log("── F02-A. 保存请求必须显式携带 baseRevision（fail-closed）──");
{
  const db = fixture({ revision: 3, answers: { trigger: "初始答案" } });
  const missing = await put(db, { answers: { trigger: "缺版本写入" }, materialStatus: "provided", ledger: null, inferenceVerdicts: {} });
  const missingBody = await jsonOf(missing);
  const after = readDraft(db);
  check("A1", "缺失 baseRevision → 428 base_revision_required；服务端不得自动用当前版本补齐",
    missing.status === 428 && missingBody.code === "base_revision_required" && missingBody.currentRevision === 3,
    `${missing.status} ${missingBody.code || ""} currentRevision=${missingBody.currentRevision}`);
  check("A2", "缺失版本的请求不产生任何写入（revision/答案不变）",
    revisionOf(db) === 3 && after.answers.trigger === "初始答案",
    `revision=${revisionOf(db)} trigger=${JSON.stringify(after.answers.trigger)}`);
  for (const bad of ["3", -1, null, 2.5]) {
    const res = await put(db, { answers: { trigger: `非法版本-${String(bad)}` }, materialStatus: "provided", baseRevision: bad });
    const body = await jsonOf(res);
    check(`A3-${String(bad)}`, `非法 baseRevision=${JSON.stringify(bad)} → 428 拒绝且不写入`,
      res.status === 428 && body.code === "base_revision_required" && revisionOf(db) === 3,
      `${res.status} ${body.code || ""} revision=${revisionOf(db)}`);
  }
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── F02-B. 正确版本推进 / 旧版本与未来版本拒绝 / 不回退 ──");
{
  const db = fixture({ revision: 3, answers: { trigger: "初始答案" } });
  const ok = await put(db, { answers: { trigger: "页面A的新答案" }, materialStatus: "provided", baseRevision: 3 });
  check("B1", "携带正确 baseRevision → 200，revision 严格 +1（3→4），答案更新",
    ok.status === 200 && revisionOf(db) === 4 && readDraft(db).answers.trigger === "页面A的新答案",
    `status=${ok.status} revision=${revisionOf(db)}`);
  const stale = await put(db, { answers: { trigger: "旧页面覆盖写入" }, materialStatus: "provided", baseRevision: 3 });
  const staleBody = await jsonOf(stale);
  check("B2", "旧版本保存 → 409 draft_conflict，返回 currentRevision，数据库不回退",
    stale.status === 409 && staleBody.code === "draft_conflict" && staleBody.currentRevision === 4
      && revisionOf(db) === 4 && readDraft(db).answers.trigger === "页面A的新答案",
    `${stale.status} ${staleBody.code || ""} currentRevision=${staleBody.currentRevision} revision=${revisionOf(db)}`);
  const future = await put(db, { answers: { trigger: "未来版本写入" }, materialStatus: "provided", baseRevision: 9 });
  const futureBody = await jsonOf(future);
  check("B3", "未来版本（大于当前 revision）→ 409，不写入",
    future.status === 409 && futureBody.code === "draft_conflict" && revisionOf(db) === 4
      && readDraft(db).answers.trigger === "页面A的新答案",
    `${future.status} ${futureBody.code || ""} revision=${revisionOf(db)}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── F02-C. 并发保存：只有一个成功，绝不静默覆盖 ──");
{
  const db = fixture({ revision: 3, answers: { trigger: "初始答案" } });
  const [first, second] = await Promise.all([
    put(db, { answers: { trigger: "并发答案甲" }, materialStatus: "provided", baseRevision: 3 }),
    put(db, { answers: { trigger: "并发答案乙" }, materialStatus: "provided", baseRevision: 3 }),
  ]);
  const firstBody = await jsonOf(first);
  const secondBody = await jsonOf(second);
  const statuses = [first.status, second.status].sort((a, b) => a - b);
  const winner = first.status === 200 ? "并发答案甲" : "并发答案乙";
  check("C1", "两个请求携带同一 baseRevision → 恰一个 200、一个 409 draft_conflict",
    statuses[0] === 200 && statuses[1] === 409
      && [firstBody.code, secondBody.code].includes("draft_conflict"),
    JSON.stringify({ first: first.status, second: second.status, codes: [firstBody.code || null, secondBody.code || null] }));
  check("C2", "最终 revision 只 +1（3→4），数据库内容为成功者，失败请求未写入",
    revisionOf(db) === 4 && readDraft(db).answers.trigger === winner,
    `revision=${revisionOf(db)} winner=${winner}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── F02-D. 前端静态契约（加载初始化真实版本 / 透传版本 / 冲突闩锁）──");
{
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const clientSrc = readFileSync(new URL("../api-client.js", import.meta.url), "utf8");
  const initRevision = appSrc.includes("if (Number.isInteger(task.draftRevision)) state.formalInterviewRevision = task.draftRevision");
  const sendsVersion = clientSrc.includes("baseRevision: Number.isInteger(extras.baseRevision) ? extras.baseRevision : undefined");
  const passesVersion = appSrc.includes("baseRevision: Number.isInteger(state.formalInterviewRevision) ? state.formalInterviewRevision : undefined");
  const conflictLatch = appSrc.includes("state.formalEmployeeConflict = true") && appSrc.includes("if (state.formalEmployeeConflict)");
  const refreshClears = appSrc.includes("state.formalEmployeeConflict = false");
  check("D1", "app.js 页面加载/刷新从 task.draftRevision 初始化真实 revision", initRevision);
  check("D2", "api-client.js 保存请求体透传 baseRevision（不再丢弃）", sendsVersion);
  check("D3", "app.js 保存调用携带 baseRevision；冲突后置闩锁并在刷新后解除",
    passesVersion && conflictLatch && refreshClears,
    JSON.stringify({ passesVersion, conflictLatch, refreshClears }));
  dbCheck: {
    // 静态检查不能代替运行验证（由 A–C 与真实浏览器覆盖），这里仅锁定契约。
  }
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── F05-A. 核验人未就绪提交：revision 不得归零/回写旧快照 ──");
{
  const records = buildInferenceRecords([], [
    { source: "model", text: "F05 基线推断 1：服务端权威记录", basis: "steps", assumes: "a" },
    { source: "model", text: "F05 基线推断 2：服务端权威记录", basis: "handoff", assumes: "a" },
  ]).records;
  // IMPLEMENT-05A：等待态提交同样要求服务端草稿 answers 完整且与规范卡/文本一致，
  // 因此夹具与提交载荷都使用同一份完整答案（触发答案仍为"初始答案"，原断言不变）。
  const answers = answersWithTrigger("初始答案");
  const db = fixture({ revision: 2, answers, records });
  const baselineIds = baselineOf(db).map((entry) => entry.id);
  // 真实推进 revision 到 3
  const advance = await put(db, { answers, materialStatus: "provided", baseRevision: 2 });
  check("W0", "前置：草稿 revision 已推进到 3", advance.status === 200 && revisionOf(db) === 3, `revision=${revisionOf(db)}`);
  const blocked = await submit(db, submissionBody(answers), "K-W1");
  const blockedBody = await jsonOf(blocked);
  const after = readDraft(db);
  check("W1", "核验人未就绪提交 → 409 verifier_not_ready，revision 3→4（N→N+1，不归零）",
    blocked.status === 409 && blockedBody.code === "verifier_not_ready"
      && Number(blockedBody.task?.draftRevision) === 4 && revisionOf(db) === 4,
    `${blocked.status} ${blockedBody.code || ""} responseRevision=${blockedBody.task?.draftRevision} dbRevision=${revisionOf(db)}`);
  check("W2", "等待态提交保留当前答案/基线（不写回请求开始时的旧快照）",
    after.answers.trigger === "初始答案"
      && baselineIds.every((id) => (after.ledger?.authoritativeInferences || []).some((entry) => entry.id === id))
      && after.submissionText === canonicalText(answers),
    `answers.trigger=${JSON.stringify(after.answers.trigger)} baseline=${(after.ledger?.authoritativeInferences || []).length}`);
  const dataAfterSubmit = JSON.stringify(after.answers);
  const staleSave = await put(db, { answers: { trigger: "旧页面覆盖写入" }, materialStatus: "provided", baseRevision: 3 });
  const staleBody = await jsonOf(staleSave);
  check("W3", "归零修复后：提交前版本的旧请求仍被拒绝（409），数据不变",
    staleSave.status === 409 && staleBody.code === "draft_conflict" && JSON.stringify(readDraft(db).answers) === dataAfterSubmit,
    `${staleSave.status} ${staleBody.code || ""} revision=${revisionOf(db)}`);
  const duplicate = await submit(db, submissionBody(answers), "K-W1-dup");
  const duplicateBody = await jsonOf(duplicate);
  check("W4", "同一文本重复等待态提交：幂等（revision 不再推进），仍返回 verifier_not_ready",
    duplicate.status === 409 && duplicateBody.code === "verifier_not_ready" && revisionOf(db) === 4,
    `${duplicate.status} ${duplicateBody.code || ""} revision=${revisionOf(db)}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── F05-B. 受控并发：等待态提交 + 草稿保存，revision 单调、无静默丢失 ──");
{
  const answers = answersWithTrigger("初始答案");
  const db = fixture({ revision: 2, answers });
  // 先制造等待态（revision 2→3）
  await submit(db, submissionBody(answers), "K-W5-pre");
  // IMPLEMENT-05A 适配：等待态提交现在逐字段校验"草稿答案派生的规范卡/文本"。
  // 为了让"保存 + 提交"两个并发请求基于**同一 revision**、且提交载荷与服务端当前答案同源，
  // 这里先合法保存一版答案 B（revision 3→4，即本用例的 startRevision），
  // 再让两个并发请求都以 revision=4 为基准：
  //   · 草稿保存 → 答案 C；
  //   · 等待态提交 → 提交文本 = 答案 B 的规范文本。
  // 冲突语义与不变量（revision 单调、明确 409、不互相覆盖）保持原样。
  const savedAnswers = answersWithTrigger("页面B的答案");
  const savedB = await put(db, { answers: savedAnswers, materialStatus: "provided", baseRevision: 3 });
  const startRevision = revisionOf(db);
  const nextAnswers = answersWithTrigger("并发保存的新答案");
  const [saveRes, submitRes] = await Promise.all([
    put(db, { answers: nextAnswers, materialStatus: "provided", baseRevision: startRevision }),
    submit(db, submissionBody(savedAnswers), "K-W5-race"),
  ]);
  const saveBody = await jsonOf(saveRes);
  const submitBodyRes = await jsonOf(submitRes);
  const finalRevision = revisionOf(db);
  const finalDraft = readDraft(db);
  // 判读口径：两个请求都基于同一个 revision 发起，但等待态提交会在写入前**重新读取**
  // 数据库当前快照再做 CAS。因此存在两种合法串行化结果：
  //   ① 保存先成功 → revision+1；提交随后基于新快照成功 → revision 再+1（两次推进都合法）；
  //   ② 提交先成功 → revision+1；保存的旧版本 CAS 失败 → 409。
  // 不变量：revision 单调前进、绝不回退/归零；冲突必须是明确的 409；两个写入不互相覆盖。
  const advanced = finalRevision > startRevision && finalRevision <= startRevision + 2;
  const saveWon = saveRes.status === 200;
  const codes = [saveBody.code, submitBodyRes.code].filter(Boolean);
  const explicitConflictOnly = [saveRes.status, submitRes.status].every((status) => status === 200 || status === 409);
  check("W5", "并发 保存+等待态提交：revision 单调前进（N→N+1 或 N+2），无回退/归零，冲突仅以明确 409 表达",
    advanced && explicitConflictOnly
      && [saveBody.code, submitBodyRes.code].every((code) => !code || ["submission_conflict", "draft_conflict", "verifier_not_ready"].includes(code)),
    JSON.stringify({ startRevision, finalRevision, save: saveRes.status, submit: submitRes.status, codes }));
  check("W6", "并发后状态一致：若保存成功则新答案保留；若提交成功则提交文本保留（不出现两者都丢）",
    (saveWon ? finalDraft.answers.trigger === "并发保存的新答案" : finalDraft.answers.trigger === "页面B的答案")
      && (saveWon || finalDraft.submissionText === canonicalText(savedAnswers)),
    JSON.stringify({ saveWon, trigger: finalDraft.answers.trigger, submissionText: String(finalDraft.submissionText).slice(0, 20) }));
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── F05-C. 核验人已就绪：正常正式提交保持可用 ──");
{
  const answers = answersWithTrigger("初始答案");
  const db = fixture({ verifierReady: true, revision: 2, answers });
  const ok = await submit(db, submissionBody(answers), "K-W7");
  const body = await jsonOf(ok);
  check("W7", "核验人已就绪时正常提交 → 200 awaiting_verification（revision 不被该路径重置）",
    ok.status === 200 && body.item?.status === "awaiting_verification" && revisionOf(db) === 2,
    `status=${ok.status} itemStatus=${body.item?.status || ""} revision=${revisionOf(db)}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── 服务端静态防线（防回退）──");
{
  const draftSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/employee-draft.js", import.meta.url), "utf8");
  const submissionSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/employee-submission.js", import.meta.url), "utf8");
  const fallbackPattern = /Number\.isInteger\(body\.baseRevision\)[\s\S]{0,80}:\s*existing\.revision/;
  check("S1", "employee-draft 不再用 existing.revision 兜底缺失版本，且缺失时返回 428",
    !fallbackPattern.test(draftSrc) && !draftSrc.includes("? body.baseRevision")
      && draftSrc.includes("base_revision_required") && draftSrc.includes("428"),
    "");
  check("S2", "employee-submission 等待核验人分支已改为条件 CAS（含 revision 条件），不再使用无条件 updateItem 写回旧草稿",
    submissionSrc.includes("json_extract(employee_draft_json,'$.revision')")
      && submissionSrc.includes("currentDraftRevision")
      && !submissionSrc.includes("updateItem(env.DB, params.itemId"),
    "");
}

// ═══════════════════════════════════════════════════════════════
const failed = results.filter((entry) => entry.verdict === "FAIL");
console.log("\n──────────────── 结果明细 ────────────────");
for (const entry of results) {
  console.log(`  ${entry.verdict === "PASS" ? "✔" : "✘"} [${entry.verdict}] ${entry.id} · ${entry.name}${entry.note ? "\n        " + entry.note : ""}`);
}
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${results.length - failed.length}  FAIL=${failed.length}`);
if (failed.length) {
  console.error(`\n  F02/F05 修复套件失败 ${failed.length} 项：${failed.map((entry) => entry.id).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("  pilot09c fix-codex-02b runtime: ok");
}
