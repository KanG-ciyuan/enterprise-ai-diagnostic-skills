/**
 * PILOT-09C/IMPLEMENT-05B —— F03 统一证据入口 · 定向运行时套件（真实 handler + 内存 D1）
 *
 * 覆盖（对抗 A1–A8 / 合法 L1–L3 / 兼容与边界）：
 *   A1. 改答案 → 受影响推断 evidenceVersion++、模板 quote/contentVersion 重建、旧判定 stale、提交被拒
 *   A2. 删答案（空串）→ history 追加 withdrawn、维度 digest 置空、提交 422 answers_incomplete
 *   A3. 旧 echo（缺 evidenceVersion / 旧版本）→ 不盖章；只有回显服务端当前版本才盖章
 *   A4. turn 成功即原子落库本轮答案 + 历史（answers 与 history 最新一致）
 *   A5. 不同维度推断不被误清空（只有依赖维度 EV 变，其余不变）
 *   A6. 证据摘要 / 历史 / 推断 refs 被绕过统一入口篡改 → 提交被拒（409 + 明确错误码）
 *   A7. 客户端提交的 ledger.statements / statementHistory 一律被服务端按 answers 重算
 *   A8. 无访谈证据（无推断/无历史）→ 提交 409 interview_evidence_missing
 *   容量：history 已达 200 条 → 追加被拒（409 statement_history_overflow）且零副作用
 *   旧草稿：无 evidence 元数据 → 首次保存受控初始化（initializedFromLegacy），旧判定仍需重判
 *   旧草稿：有 answers/history 但无 evidence 元数据 → 提交 409 evidence_metadata_missing
 *   L1. 合法访谈→判定→提交 200 awaiting_verification，facts=5
 *   L2. 合法补正→重判→提交 200，事实含补正陈述
 *   L3. 等待核验人分支同样先过证据门禁（不一致 → 409 且不写 blocked_draft；一致 → verifier_not_ready）
 *
 * 说明：这是 handler 级回归（真实 handler + 内存 D1）；真实 HTTP/浏览器证据见
 * PILOT-09C-IMPLEMENT-05B-evidence/regression/ 与 green/。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeEmployeeDraft, serializeEmployeeDraft } from "../functions/_shared.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { onRequestPost as agentTurn } from "../functions/api/agent/employee-turn.js";
import {
  ANSWER_DIMENSIONS, canonicalJson, normalizeAnswers, validateSubmissionEvidence,
} from "../functions/api/agent/_evidence.js";
import {
  appendStatementHistory, buildInferenceRecords, buildInferences, normalizeInference, resolveInferenceJudgment,
} from "../functions/api/agent/_adapter.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const P = "PRJ-IMP05B", ITEM = "WI-IMP05B", EMP = "ACC-IMP05B-EMP", VER = "ACC-IMP05B-VER", TOK = "TOK-IMP05B";
const KEY = "fake-deepseek-key-not-real-not-used";   // 仅本地确定性引擎；绝不触网
const HISTORY_LIMIT = 200;                            // _evidence.js 的陈述历史上限（契约常量）

const ANSWERS = {
  trigger: "每天早上运营同事在群里发来当天的推广需求，我看到消息后开始处理",
  inputs: "先看昨天的曝光和点击数据，再看库存数量，然后确认投放预算还剩多少",
  steps: "先选品再写脚本，然后让剪辑同事剪出来，最后在后台提交审核并发布",
  judgments: "毛利率低于一成要先找主管确认，其他价格我自己按历史数据定",
  exceptions: "版权不确定就换同款，审核被拒就先改文案再重新提交",
  handoff: "剪完的素材交给投放同事小李，由他挂车和设置出价",
  burden: "一条视频从选题到发布大约需要三个小时，一周做五条左右",
};
const NEW_STEPS = "先让剪辑同事按脚本初剪，我再挑品并确认价格，最后提交审核发布";
const CORRECTED_EXCEPTIONS = "补正：版权不确定时先找法务确认，确认不了才换同款";
const DIMENSION_LABELS = {
  trigger: "从哪里开始", inputs: "先看什么", steps: "实际怎么做",
  judgments: "哪些情况不能自己决定", exceptions: "卡住后怎么办",
  handoff: "交给谁", burden: "大约多久",
};
const MATERIAL_INDEX_LABELS = {
  provided: "员工已说明有材料，等待登记",
  none_available: "目前没有可提供的材料",
  undecided: "尚未选择",
};
const canonicalCard = (answers, materialStatus = "provided") => {
  const card = {};
  for (const key of ANSWER_DIMENSIONS) card[key] = String(answers[key] || "").trim();
  card.materialIndex = MATERIAL_INDEX_LABELS[materialStatus];
  return card;
};
const canonicalText = (answers) => ANSWER_DIMENSIONS.map((key) => `${DIMENSION_LABELS[key]}：${String(answers[key] || "").trim()}`).join("\n\n");

// ── 服务端证据状态（夹具）：与真实统一证据入口写入同构 ───────────────────────
// 摘要按服务端同一算法（sha256: + hex(canonicalJson(normalizeAnswers(answers)))）用
// node:crypto 独立计算；statementHistory 用服务端 appendStatementHistory 生成。
const evidenceSha256 = (value) => `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
function seedEvidenceState({ answers = {}, inferences = [], revision = 0, verdicts = null, defaultVerdict = "agree", historyOverride = null }) {
  const normalized = normalizeAnswers(answers);
  let history = historyOverride || [];
  if (!historyOverride) {
    for (const dimension of ANSWER_DIMENSIONS) {
      if (!normalized[dimension]) continue;
      history = appendStatementHistory({ prior: history, dimension, text: normalized[dimension], revision }).history;
    }
  }
  const dimensions = {};
  for (const dimension of ANSWER_DIMENSIONS) {
    dimensions[dimension] = {
      digest: normalized[dimension] ? evidenceSha256(normalized[dimension]) : null,
      seq: normalized[dimension] ? 1 : 0,
    };
  }
  const evidence = {
    schemaVersion: 1, seq: history.length ? 1 : 0,
    answersDigest: evidenceSha256(canonicalJson(normalized)),
    dimensions, revision, updatedAt: new Date().toISOString(),
    // PILOT-09C/G14：证据/依赖规则版本（提交门禁要求 === G14_RULE_VERSION=1）。
    ruleVersion: 1,
  };
  const seededInferences = inferences.map((entry) => {
    const basis = ANSWER_DIMENSIONS.includes(entry.basis) ? entry.basis : null;
    const isTemplate = entry.source === "server_template";
    const suppliedRefs = Array.isArray(entry.evidenceRefs)
      ? entry.evidenceRefs.filter((ref) => ref && ANSWER_DIMENSIONS.includes(ref.dimension)) : [];
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
      evidenceRefs: isTemplate ? refs : ANSWER_DIMENSIONS.filter((dim) => dimensions[dim]?.digest)
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
      contentVersion: supplied && Number.isInteger(supplied.contentVersion) ? supplied.contentVersion : entry.contentVersion,
      templateVersion: supplied && Object.prototype.hasOwnProperty.call(supplied, "templateVersion")
        ? (Number.isInteger(supplied.templateVersion) ? supplied.templateVersion : null)
        : (entry.templateVersion === undefined ? null : entry.templateVersion),
      evidenceHash: supplied && Object.prototype.hasOwnProperty.call(supplied, "evidenceHash")
        ? (typeof supplied.evidenceHash === "string" ? supplied.evidenceHash : null)
        : (entry.evidenceHash || null),
      evidenceVersion: supplied && Number.isInteger(supplied.evidenceVersion) ? supplied.evidenceVersion : entry.evidenceVersion,
    };
  }
  return { normalized, history, evidence, inferences: seededInferences, verdicts: seededVerdicts };
}

/** 服务端同源的推断基线：模板（buildInferences）+ 模型（buildInferenceRecords） */
function baselineInferences(answers) {
  const templates = buildInferences({ statements: answers }, {});
  const models = [
    { source: "model", text: "访谈基线推断：素材剪完交给投放同事挂车发布", basis: "handoff", assumes: "若实际不是这样需更正" },
    { source: "model", text: "访谈基线推断：一条视频从选题到发布约需三个小时", basis: "burden", assumes: "若实际耗时不同需更正" },
  ];
  return buildInferenceRecords([], [...templates, ...models]).records;
}

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });
const check = (id, name, ok, note = "") => (ok ? pass(id, name, note) : fail(id, name, note));
const resultsOf = (verdict) => results.filter((entry) => entry.verdict === verdict).length;

/**
 * fixture：合法正式项目 + 员工任务 + 草稿。
 * opts.answers 草稿答案；opts.inferences 服务端推断基线；opts.verdicts 判定（null=按条目默认 agree，{} = 无判定）；
 * opts.withEvidence=false 时不写证据元数据（旧草稿）；opts.history 覆盖 history；opts.verifierReady 核验人是否就绪。
 */
function fixture(opts = {}) {
  const {
    answers = ANSWERS,
    inferences = null,
    verdicts = null,
    revision = 0,
    verifierReady = true,
    withEvidence = true,
    history = null,
    status = "needs_input",
    burdenAsked = false,
  } = opts;
  const db = new D1Harness();
  const baseInferences = inferences === null ? baselineInferences(answers) : inferences;
  const seed = seedEvidenceState({
    answers, inferences: baseInferences, revision,
    verdicts: verdicts === null ? null : verdicts,
    historyOverride: history,
  });
  const ledger = {
    statements: {}, covered: [], vagueTerms: [], unresolved: [],
    authoritativeInferences: seed.inferences, statementHistory: seed.history,
    burdenAsked,
  };
  if (withEvidence) ledger.evidence = seed.evidence;
  const draft = serializeEmployeeDraft({
    answers,
    ledger,
    inferenceVerdicts: seed.verdicts,
    submissionText: "",
    revision,
  });
  const verifierInvitation = verifierReady
    ? `('INV-IMP05B-VER','inv-imp05b-ver','${P}','${EMP}','ver@imp05b.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','IK-IMP05B')`
    : `('INV-IMP05B-VER','inv-imp05b-ver','${P}','${EMP}','ver@imp05b.invalid','verifier','project','pending','2099-01-01T00:00:00Z',NULL,'IK-IMP05B')`;
  const verifierMembership = verifierReady
    ? `INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES ('${P}','${VER}','verifier','project','active');`
    : "";
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@imp05b.invalid','员工甲','active','member'),
      ('${VER}','ver@imp05b.invalid','核验人乙','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage)
      VALUES ('${P}','IMP-05B 验证','选品到发布','mapping','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES ('${P}','${EMP}','employee','project','active');
    ${verifierMembership}
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-IMP05B','${P}','授权','王总','o@imp05b.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key)
      VALUES ${verifierInvitation};
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version)
      VALUES ('${ITEM}','${P}','还原工作','d','mapping','${status}','employee','员工甲',0,'b','n','${EMP}',
              ${verifierReady ? `'${VER}'` : "NULL"},'${draft.replace(/'/g, "''")}','provided',1,1);
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R-IMP05B');
  `);
  return db;
}

const itemOf = (db) => db.get("SELECT * FROM work_items WHERE id=?", ITEM);
const draftOf = (db) => normalizeEmployeeDraft(JSON.parse(itemOf(db).employee_draft_json || "{}"));
const revisionOf = (db) => draftOf(db).revision;
const baselineOf = (db) => draftOf(db).ledger?.authoritativeInferences || [];
const factsOf = (db) => db.all("SELECT * FROM candidate_facts WHERE work_item_id=? ORDER BY id", ITEM);
const eventsOf = (db) => db.all("SELECT type, payload FROM events WHERE work_item_id=? ORDER BY id", ITEM);
const snapshotOf = (db) => JSON.stringify({ item: itemOf(db), facts: factsOf(db), events: eventsOf(db).map((event) => event.type) });
const jsonOf = async (response) => response.clone().json().catch(() => ({}));
const put = (db, body) => saveDraft({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, TOK, body),
  env: { DB: db }, params: { itemId: ITEM },
});
const submit = (db, body, key = `K-${Math.random()}`) => submitEmployee({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK,
    { ...body, baseRevision: Number.isInteger(body.baseRevision) ? body.baseRevision : revisionOf(db) },
    { "Idempotency-Key": key }),
  env: { DB: db }, params: { itemId: ITEM },
});
const turn = (db, body, envExtra = {}) => agentTurn({
  request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", TOK, body),
  env: { DB: db, ...envExtra }, params: {},
});
const submissionBody = (answers, extra = {}) => ({
  text: canonicalText(answers), workflowCard: canonicalCard(answers, "provided"),
  materialStatus: "provided", inferences: [], inferenceVerdicts: {}, ...extra,
});
const echoVerdicts = (inferences, verdict = "agree") => Object.fromEntries(inferences.map((entry) => [entry.id, {
  verdict,
  correction: "",
  contentVersion: entry.contentVersion,
  templateVersion: entry.templateVersion === undefined ? null : entry.templateVersion,
  evidenceHash: entry.evidenceHash || null,
  evidenceVersion: entry.evidenceVersion,
}]));
/** 直接改库草稿（模拟"绕过统一证据入口"的攻击/篡改）。 */
function tamperDraft(db, mutate) {
  const draft = JSON.parse(itemOf(db).employee_draft_json || "{}");
  mutate(draft);
  db.prepare("UPDATE work_items SET employee_draft_json=? WHERE id=?").bind(JSON.stringify(draft), ITEM).run();
}
const entryOf = (db, basis, source = "server_template") => baselineOf(db).find((entry) => entry.basis === basis && entry.source === source)
  || baselineOf(db).find((entry) => entry.basis === basis);

console.log("PILOT-09C/IMPLEMENT-05B · F03 统一证据入口 —— 定向运行时套件\n");

// ═══════════════════════════════════════════════════════════════
console.log("── A1/A5/A6 证据版本与失效语义 ──");
{
  const db = fixture();
  const before = baselineOf(db);
  const stepsTemplateBefore = entryOf(db, "steps");
  const judgmentsBefore = entryOf(db, "judgments");
  const handoffBefore = entryOf(db, "handoff", "model");
  const saved = await put(db, { answers: { ...ANSWERS, steps: NEW_STEPS }, materialStatus: "provided", baseRevision: revisionOf(db) });
  const savedBody = await jsonOf(saved);
  const after = baselineOf(db);
  const stepsTemplateAfter = after.find((entry) => entry.id === stepsTemplateBefore.id);
  const judgmentsAfter = after.find((entry) => entry.id === judgmentsBefore.id);
  const handoffAfter = after.find((entry) => entry.id === handoffBefore.id);
  check("A1-1", "改答案 → 依赖 steps 的推断 evidenceVersion 恰好 +1",
    saved.status === 200 && stepsTemplateAfter.evidenceVersion === stepsTemplateBefore.evidenceVersion + 1,
    `put=${saved.status} ev ${stepsTemplateBefore.evidenceVersion}→${stepsTemplateAfter.evidenceVersion}`);
  check("A1-2", "改答案 → 模板推断 quote 与当前答案一致、contentVersion 推进（1→2）",
    stepsTemplateAfter.quote === NEW_STEPS && stepsTemplateAfter.contentVersion === 2
      && stepsTemplateAfter.quote !== stepsTemplateBefore.quote,
    `cv=${stepsTemplateAfter.contentVersion} quote=${String(stepsTemplateAfter.quote).slice(0, 18)}`);
  check("A1-3", "旧判定失效（stale）→ 提交被 422 inferences_unjudged 拒绝",
    resolveInferenceJudgment(stepsTemplateAfter, draftOf(db).inferenceVerdicts) === "stale"
      && (await submit(db, submissionBody({ ...ANSWERS, steps: NEW_STEPS }), "K-A1")).status === 422,
    `stale=${resolveInferenceJudgment(stepsTemplateAfter, draftOf(db).inferenceVerdicts)}`);
  check("A5-1", "无关 judgments 模板 EV 不变；无建议的 handoff 模型保守依赖 steps，EV+1，记录不丢失",
    judgmentsAfter.evidenceVersion === judgmentsBefore.evidenceVersion
      && handoffAfter.evidenceVersion === handoffBefore.evidenceVersion + 1
      && after.length === before.length,
    `judgments=${judgmentsAfter.evidenceVersion} handoff=${handoffAfter.evidenceVersion}`);
  check("A5-2", "无关模板仍 valid；保守依赖的模型旧判定必须 stale",
    resolveInferenceJudgment(judgmentsAfter, draftOf(db).inferenceVerdicts) === "valid"
      && resolveInferenceJudgment(handoffAfter, draftOf(db).inferenceVerdicts) === "stale",
    "judgments valid / conservative handoff stale");
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── A2 删除答案（withdrawn）──");
{
  const db = fixture();
  const saved = await put(db, { answers: { steps: "" }, materialStatus: "provided", baseRevision: revisionOf(db) });
  const draft = draftOf(db);
  const stepsHistory = (draft.ledger.statementHistory || []).filter((entry) => entry.dimension === "steps");
  check("A2-1", "删除答案（空串）→ history 追加 kind=withdrawn（append-only），答案被清除",
    saved.status === 200 && !draft.answers.steps
      && stepsHistory.length >= 2 && stepsHistory[stepsHistory.length - 1].kind === "withdrawn",
    `status=${saved.status} history=${stepsHistory.map((entry) => entry.kind).join(",")}`);
  check("A2-2", "删除答案 → 维度 digest 置空、answersDigest 变化",
    draft.ledger.evidence.dimensions.steps.digest === null
      && draft.ledger.evidence.answersDigest !== evidenceSha256(canonicalJson(normalizeAnswers(ANSWERS))),
    `digest=${draft.ledger.evidence.dimensions.steps.digest}`);
  const res = await submit(db, { ...submissionBody({ ...ANSWERS, steps: "" }), text: canonicalText({ ...ANSWERS, steps: "" }), workflowCard: canonicalCard({ ...ANSWERS, steps: "" }) }, "K-A2");
  const body = await jsonOf(res);
  check("A2-3", "答案不完整 → 提交被 422 answers_incomplete（F04）拦截",
    res.status === 422 && body.code === "answers_incomplete"
      && Array.isArray(body.missingDimensions) && body.missingDimensions.includes("steps"),
    `${res.status} ${body.code || ""} missing=${JSON.stringify(body.missingDimensions || [])}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── A3 旧 echo 不盖章 / 当前版本才盖章 ──");
{
  const db = fixture();
  const baseline = baselineOf(db);
  const target = baseline[0];
  const beforeVerdicts = JSON.stringify(draftOf(db).inferenceVerdicts);
  const forged = await put(db, {
    answers: {}, materialStatus: "provided", baseRevision: revisionOf(db),
    inferenceVerdicts: { [target.id]: { verdict: "agree", contentVersion: 999, templateVersion: target.templateVersion, evidenceHash: target.evidenceHash } },
  });
  const forgedBody = await jsonOf(forged);
  check("A3-1", "伪造/旧版本 echo → 明确被拒（rejected=version_mismatch），库中判定不变",
    forged.status === 200 && forgedBody.verdictResult.rejected.length === 1
      && forgedBody.verdictResult.rejected[0].reason === "version_mismatch"
      && JSON.stringify(draftOf(db).inferenceVerdicts) === beforeVerdicts,
    JSON.stringify(forgedBody.verdictResult.rejected[0] && forgedBody.verdictResult.rejected[0].reason));
  // 用**不同判定**（corrected）验证"未被盖章"：若被盖章则库中判定会从 agree 变为 corrected。
  const missingEvidenceVersion = await put(db, {
    answers: {}, materialStatus: "provided", baseRevision: revisionOf(db),
    inferenceVerdicts: { [target.id]: { verdict: "correct", correction: "其实是版权原因", contentVersion: target.contentVersion, templateVersion: target.templateVersion, evidenceHash: target.evidenceHash } },
  });
  const missingBody = await jsonOf(missingEvidenceVersion);
  const storedAfterMissing = draftOf(db).inferenceVerdicts[target.id];
  check("A3-2", "缺 evidenceVersion 的 echo（旧客户端）→ 明确 rejected，且库中判定未被重新盖章",
    missingEvidenceVersion.status === 200 && missingBody.verdictResult.rejected.length === 1
      && missingBody.verdictResult.rejected[0].id === target.id
      && storedAfterMissing?.verdict !== "corrected",
    JSON.stringify({ reason: missingBody.verdictResult.rejected[0] && missingBody.verdictResult.rejected[0].reason, stored: storedAfterMissing?.verdict || null }));
  const current = baselineOf(db);
  const good = await put(db, {
    answers: {}, materialStatus: "provided", baseRevision: revisionOf(db),
    inferenceVerdicts: echoVerdicts(current),
  });
  const goodBody = await jsonOf(good);
  check("A3-3", "回显服务端当前版本（含 evidenceVersion）→ 逐条盖章 accepted",
    good.status === 200 && goodBody.verdictResult.rejected.length === 0
      && goodBody.verdictResult.acceptedIds.length === current.length,
    `accepted=${goodBody.verdictResult.acceptedIds.length}/${current.length}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── A4 turn 原子落库（answers == history 最新）──");
{
  const db = fixture({ answers: {}, inferences: [], verdicts: {} });
  const turn = (body) => agentTurn({
    request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", TOK, body),
    env: { DB: db, FORMAL_AGENT_TEST_MODE: "1" }, params: {},
  });
  const recover = await turn({ projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revisionOf(db) });
  const recoverBody = await jsonOf(recover);
  const anchor = recoverBody?.turn?.nextQuestion?.key || draftOf(db).ledger?.pendingQuestion?.key;
  const answered = await turn({
    projectId: P, workItemId: ITEM, questionKey: anchor,
    answer: ANSWERS[anchor] || "按实际流程操作",
    mode: "fixture", baseRevision: revisionOf(db),
  });
  const draft = draftOf(db);
  const latest = (draft.ledger.statementHistory || []).filter((entry) => entry.dimension === anchor).slice(-1)[0] || null;
  check("A4-1", "turn 成功即落库本轮答案（不依赖客户端再保存草稿）",
    recover.status === 200 && answered.status === 200 && draft.answers[anchor] === (ANSWERS[anchor] || "按实际流程操作"),
    `recover=${recover.status} turn=${answered.status} key=${anchor}`);
  check("A4-2", "本轮答案与 statementHistory 最新条目一致（原子：answers==history）",
    Boolean(latest) && latest.kind !== "withdrawn" && latest.text === draft.answers[anchor],
    JSON.stringify(latest && { kind: latest.kind, text: latest.text.slice(0, 16) }));
  check("A4-3", "turn 同一 CAS 内写入证据元数据（answersDigest/维度 digest 与答案一致）",
    draft.ledger?.evidence && typeof draft.ledger.evidence.answersDigest === "string"
      && draft.ledger.evidence.dimensions[anchor].digest === evidenceSha256(normalizeAnswers(draft.answers)[anchor]),
    `evidence=${Boolean(draft.ledger?.evidence)}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── A6 绕过统一入口篡改证据 → 提交被拒 ──");
{
  // A6-1：answersDigest 不一致
  const db1 = fixture();
  tamperDraft(db1, (draft) => { draft.ledger.evidence.answersDigest = `sha256:${"0".repeat(64)}`; });
  const before1 = snapshotOf(db1);
  const r1 = await submit(db1, submissionBody(ANSWERS), "K-A6-1");
  const b1 = await jsonOf(r1);
  check("A6-1", "篡改 answersDigest → 409 evidence_digest_mismatch，零写入",
    r1.status === 409 && b1.code === "evidence_digest_mismatch" && snapshotOf(db1) === before1,
    `${r1.status} ${b1.code || ""}`);
  db1.close();

  // A6-2：statementHistory 与答案不一致（绕过统一入口改答案）
  const db2 = fixture();
  tamperDraft(db2, (draft) => {
    draft.answers.steps = "绕过统一入口写入的新步骤，未进入历史";
  });
  const before2 = snapshotOf(db2);
  const r2 = await submit(db2, submissionBody({ ...ANSWERS, steps: "绕过统一入口写入的新步骤，未进入历史" }), "K-A6-2");
  const b2 = await jsonOf(r2);
  check("A6-2", "答案被绕过统一入口修改（history/摘要不一致）→ 409 evidence_history_mismatch，零写入",
    r2.status === 409 && b2.code === "evidence_history_mismatch" && snapshotOf(db2) === before2,
    `${r2.status} ${b2.code || ""}`);
  db2.close();

  // A6-3：推断 evidenceRefs 摘要与当前证据不一致
  const db3 = fixture();
  tamperDraft(db3, (draft) => {
    const entry = draft.ledger.authoritativeInferences.find((item) => item.source === "server_template");
    entry.evidenceRefs = [{ dimension: entry.basis, digest: `sha256:${"f".repeat(64)}` }];
  });
  const before3 = snapshotOf(db3);
  const r3 = await submit(db3, submissionBody(ANSWERS), "K-A6-3");
  const b3 = await jsonOf(r3);
  check("A6-3", "推断 evidenceRefs 摘要不一致 → 409 inference_evidence_stale，零写入",
    r3.status === 409 && b3.code === "inference_evidence_stale" && snapshotOf(db3) === before3,
    `${r3.status} ${b3.code || ""}`);
  db3.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── A7 客户端 statements / statementHistory 被重算 ──");
{
  const db = fixture();
  const historyBefore = JSON.stringify(draftOf(db).ledger.statementHistory);
  const evidenceBefore = JSON.stringify(draftOf(db).ledger.evidence);
  const res = await put(db, {
    answers: {}, materialStatus: "provided", baseRevision: revisionOf(db),
    ledger: {
      statements: { trigger: "【伪造】客户端声明的触发方式", steps: "【伪造】客户端步骤" },
      covered: ["trigger", "steps"],
      vagueTerms: [], unresolved: [], evidence: [],
      statementHistory: [{ seq: 999, dimension: "steps", text: "【伪造】历史条目", kind: "initial", source: "client" }],
    },
  });
  const draft = draftOf(db);
  check("A7-1", "客户端伪造 ledger.statements → 服务端按 answers 重算（伪造值不落库）",
    res.status === 200
      && draft.ledger.statements.trigger === normalizeAnswers(ANSWERS).trigger
      && draft.ledger.statements.steps === normalizeAnswers(ANSWERS).steps,
    `status=${res.status} trigger=${String(draft.ledger.statements.trigger).slice(0, 12)}`);
  check("A7-2", "客户端伪造 statementHistory → 一律丢弃，服务端历史未被污染",
    JSON.stringify(draft.ledger.statementHistory) === historyBefore
      && !draft.ledger.statementHistory.some((entry) => entry.seq === 999),
    `history=${draft.ledger.statementHistory.length}`);
  check("A7-3", "答案未变化 → 证据元数据保持不变（幂等保存不制造证据变化）",
    JSON.stringify(draft.ledger.evidence) === evidenceBefore,
    `seq=${draft.ledger.evidence.seq}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── A8 无访谈证据不得提交 ──");
{
  // A8-1：有答案、有历史，但没有推断基线（无访谈）→ 409 interview_evidence_missing
  const db1 = fixture({ inferences: [], verdicts: {} });
  const before1 = snapshotOf(db1);
  const r1 = await submit(db1, submissionBody(ANSWERS), "K-A8-1");
  const b1 = await jsonOf(r1);
  check("A8-1", "无 authoritativeInferences（无访谈）→ 409 interview_evidence_missing，零写入",
    r1.status === 409 && b1.code === "interview_evidence_missing" && snapshotOf(db1) === before1,
    `${r1.status} ${b1.code || ""}`);
  db1.close();
  // A8-2：答案完整但完全没有访谈证据（无 history、无推断、无 evidence）→ 同样被拒
  const db2 = fixture({ answers: ANSWERS, inferences: [], verdicts: {}, withEvidence: false, history: [] });
  const r2 = await submit(db2, submissionBody(ANSWERS), "K-A8-2");
  const b2 = await jsonOf(r2);
  check("A8-2", "答案完整但无任何访谈证据（无 history/推断/evidence）→ 409 interview_evidence_missing",
    r2.status === 409 && b2.code === "interview_evidence_missing",
    `${r2.status} ${b2.code || ""}`);
  db2.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── 旧草稿：evidence 元数据缺失（历史兼容）──");
{
  // 旧草稿 A：有 answers + 旧判定，但无 evidence / 无 history → 首次保存受控初始化
  const oldInferences = baselineInferences(ANSWERS);
  const oldVerdicts = Object.fromEntries(oldInferences.map((entry) => [entry.id, {
    verdict: "agree", correction: "",
    contentVersion: entry.contentVersion,
    templateVersion: entry.templateVersion === undefined ? null : entry.templateVersion,
    evidenceHash: entry.evidenceHash || null,
    // 旧判定：无 evidenceVersion
  }]));
  const db = new D1Harness();
  const legacyAnswers = ANSWERS;
  const legacyDraft = serializeEmployeeDraft({
    answers: legacyAnswers,
    ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], authoritativeInferences: oldInferences, statementHistory: [], burdenAsked: false },
    inferenceVerdicts: oldVerdicts, submissionText: "", revision: 0,
  });
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES ('${EMP}','emp@imp05b.invalid','员工甲','active','member'),('${VER}','ver@imp05b.invalid','核验人乙','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES ('${P}','IMP-05B 兼容','选品到发布','mapping','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES ('${P}','${EMP}','employee','project','active'),('${P}','${VER}','verifier','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES ('AUTH-IMP05B','${P}','授权','王总','o@imp05b.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key) VALUES ('INV-IMP05B-VER','inv-imp05b-ver','${P}','${EMP}','ver@imp05b.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','IK-IMP05B');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version) VALUES ('${ITEM}','${P}','还原工作','d','mapping','needs_input','employee','员工甲',0,'b','n','${EMP}','${VER}','${legacyDraft.replace(/'/g, "''")}','provided',1,1);
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R-IMP05B');
  `);
  const putRes = await put(db, { answers: legacyAnswers, materialStatus: "provided", baseRevision: 0 });
  const afterInit = draftOf(db);
  check("LEGACY-1", "旧草稿（无 evidence 元数据）首次保存 → 200，服务端受控初始化 history + evidence（initializedFromLegacy）",
    putRes.status === 200 && afterInit.ledger?.evidence?.initializedFromLegacy === true
      && afterInit.ledger.statementHistory.length === 7,
    `status=${putRes.status} history=${(afterInit.ledger?.statementHistory || []).length}`);
  const blocked = await submit(db, submissionBody(legacyAnswers), "K-LEGACY-1");
  const blockedBody = await jsonOf(blocked);
  check("LEGACY-2", "旧判定（无 evidenceVersion）不自动有效 → 提交 422 inferences_unjudged",
    blocked.status === 422 && blockedBody.code === "inferences_unjudged",
    `${blocked.status} ${blockedBody.code || ""}`);
  const baseline = baselineOf(db);
  const rejudge = await put(db, {
    answers: {}, materialStatus: "provided", baseRevision: revisionOf(db),
    inferenceVerdicts: echoVerdicts(baseline),
  });
  const rejudgeBody = await jsonOf(rejudge);
  check("LEGACY-3", "GET→按新基线回显版本保存判定 → 逐条盖章 accepted",
    rejudge.status === 200 && rejudgeBody.verdictResult.acceptedIds.length === baseline.length,
    `accepted=${rejudgeBody.verdictResult.acceptedIds.length}/${baseline.length}`);
  const ok = await submit(db, submissionBody(legacyAnswers), "K-LEGACY-2");
  const okBody = await jsonOf(ok);
  check("LEGACY-4", "重新确认后可提交 → 200 awaiting_verification",
    ok.status === 200 && okBody.item?.status === "awaiting_verification",
    `${ok.status} ${okBody.item?.status || ""}`);
  db.close();
}
{
  // 旧草稿 B：有 answers + 与答案一致的历史，但无 evidence 元数据 → 409 evidence_metadata_missing
  const history = seedEvidenceState({ answers: ANSWERS, inferences: [], revision: 0 }).history;
  const db = fixture({ history, withEvidence: false, verdicts: {} });
  const r = await submit(db, submissionBody(ANSWERS), "K-LEGACY-META");
  const b = await jsonOf(r);
  check("LEGACY-5", "旧草稿（有 answers/history、无 evidence 元数据）提交 → 409 evidence_metadata_missing",
    r.status === 409 && b.code === "evidence_metadata_missing",
    `${r.status} ${b.code || ""}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── 容量：history 200 条上限（追加被拒且零副作用）──");
{
  let history = [];
  for (let index = 0; index < HISTORY_LIMIT; index += 1) {
    const dimension = ANSWER_DIMENSIONS[index % ANSWER_DIMENSIONS.length];
    history = appendStatementHistory({
      prior: history, dimension, text: `第 ${index + 1} 条历史陈述（容量测试）`, revision: index,
    }).history;
  }
  const db = fixture({ history, verdicts: {} });
  const before = snapshotOf(db);
  const revisionBefore = revisionOf(db);
  const res = await put(db, { answers: { steps: NEW_STEPS }, materialStatus: "provided", baseRevision: revisionBefore });
  const body = await jsonOf(res);
  check("CAP-1", "history 已达 200 条 → 追加被 409 statement_history_overflow 拒绝",
    res.status === 409 && body.code === "statement_history_overflow",
    `${res.status} ${body.code || ""}`);
  check("CAP-2", "拒绝后零副作用（revision / 草稿 / 事件均不变）",
    revisionOf(db) === revisionBefore && snapshotOf(db) === before,
    `revision=${revisionBefore}→${revisionOf(db)}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── L1 合法访谈 → 判定 → 提交 ──");
{
  const db = fixture();
  const res = await submit(db, submissionBody(ANSWERS), "K-L1");
  const body = await jsonOf(res);
  const item = itemOf(db);
  const facts = factsOf(db);
  const submitted = eventsOf(db).find((event) => event.type === "employee_submitted");
  const payload = submitted ? JSON.parse(submitted.payload) : {};
  check("L1-1", "合法提交 → 200 awaiting_verification，facts=5",
    res.status === 200 && item.status === "awaiting_verification" && item.stage === "facts"
      && facts.length === 5 && item.submission_version === 1,
    `${res.status} status=${item.status} facts=${facts.length}`);
  check("L1-2", "candidate_facts 来自服务端规范卡（包含全部维度答案内容）",
    facts.every((fact) => typeof fact.claim === "string" && fact.claim.length > 0)
      && facts.some((fact) => fact.claim.includes(ANSWERS.steps.slice(0, 10)))
      && facts.some((fact) => fact.claim.includes(ANSWERS.burden.slice(0, 10))),
    facts.map((fact) => fact.source_field).join("|"));
  check("L1-3", "employee_submitted 审计快照含证据版本字段（evidenceSeq/answersDigest/history 边界）",
    typeof payload.evidenceSeq === "number" && typeof payload.evidenceAnswersDigest === "string"
      && payload.evidenceAnswersDigest.startsWith("sha256:")
      && Number.isInteger(payload.statementHistorySeq) && Number.isInteger(payload.statementHistoryCount),
    `ev=${payload.evidenceSeq} history=${payload.statementHistoryCount}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── L2 合法补正（turn 补正锚点）→ 重判 → 提交 ──");
{
  const db = fixture({ burdenAsked: true });
  // 1) 服务端签发补正锚点（correction 意图只来自服务端锚点）；recover 不调用模型。
  const recover = await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revisionOf(db), supplement: { dimension: "exceptions", intent: "correction" } });
  const recoverBody = await jsonOf(recover);
  const anchorKey = recoverBody?.turn?.nextQuestion?.key || draftOf(db).ledger?.pendingQuestion?.key;
  // 2) 回答补正锚点（harness + 本地 stub 模型，不触网）。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ turnKind: "draft", question: null, endingProposal: { recommended: true, reason: "覆盖已满足" } }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  let answered; let answeredBody;
  try {
    answered = await turn(db, {
      projectId: P, workItemId: ITEM, questionKey: anchorKey, answer: CORRECTED_EXCEPTIONS,
      mode: "harness", baseRevision: revisionOf(db),
    }, { DEEPSEEK_API_KEY: KEY });
    answeredBody = await jsonOf(answered);
  } finally { globalThis.fetch = originalFetch; }
  const changedAnswers = { ...ANSWERS, exceptions: CORRECTED_EXCEPTIONS };
  const exceptionsTemplate = entryOf(db, "exceptions");
  check("L2-1", "合法补正（服务端补正锚点作答）→ history 追加 correction、模板 quote 更新为补正答案",
    recover.status === 200 && answered.status === 200
      && (draftOf(db).ledger.statementHistory || []).some((entry) => entry.dimension === "exceptions" && entry.kind === "correction")
      && exceptionsTemplate.quote === CORRECTED_EXCEPTIONS
      && draftOf(db).answers.exceptions === CORRECTED_EXCEPTIONS,
    `recover=${recover.status} turn=${answered.status} kind=${answeredBody?.turn?.turnKind} quote=${String(exceptionsTemplate.quote).slice(0, 16)}`);
  const blocked = await submit(db, submissionBody(changedAnswers), "K-L2-blocked");
  const blockedBody = await jsonOf(blocked);
  check("L2-2", "补正后旧判定未重判 → 提交 422 inferences_unjudged",
    blocked.status === 422 && blockedBody.code === "inferences_unjudged",
    `${blocked.status} ${blockedBody.code || ""}`);
  const rejudge = await put(db, {
    answers: {}, materialStatus: "provided", baseRevision: revisionOf(db),
    inferenceVerdicts: echoVerdicts(baselineOf(db)),
  });
  const rejudgeBody = await jsonOf(rejudge);
  const ok = await submit(db, submissionBody(changedAnswers), "K-L2-ok");
  const okBody = await jsonOf(ok);
  const exceptionFact = factsOf(db).find((fact) => fact.claim.includes(CORRECTED_EXCEPTIONS.slice(0, 12)));
  check("L2-3", "按当前基线重判 → 提交 200 awaiting_verification，事实含补正陈述",
    rejudge.status === 200 && rejudgeBody.verdictResult.acceptedIds.length === baselineOf(db).length
      && ok.status === 200 && okBody.item?.status === "awaiting_verification" && Boolean(exceptionFact),
    `rejudge=${rejudge.status} submit=${ok.status} fact=${Boolean(exceptionFact)}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── L3 等待核验人分支同样先过证据门禁 ──");
{
  // L3-1：证据不一致 → 拒绝，且不写 blocked_draft
  const db1 = fixture({ verifierReady: false });
  tamperDraft(db1, (draft) => { draft.ledger.evidence.answersDigest = `sha256:${"1".repeat(64)}`; });
  const before1 = snapshotOf(db1);
  const r1 = await submit(db1, submissionBody(ANSWERS), "K-L3-1");
  const b1 = await jsonOf(r1);
  const item1 = itemOf(db1);
  check("L3-1", "等待分支证据不一致 → 409 evidence_digest_mismatch，且不写 blocked_draft/草稿",
    r1.status === 409 && b1.code === "evidence_digest_mismatch"
      && item1.status === "needs_input" && item1.handoff_status !== "waiting_assignment"
      && snapshotOf(db1) === before1,
    `${r1.status} ${b1.code || ""} status=${item1.status}`);
  db1.close();
  // L3-2：证据一致 → 409 verifier_not_ready，blocked_draft，零候选事实
  const db2 = fixture({ verifierReady: false });
  const r2 = await submit(db2, submissionBody(ANSWERS), "K-L3-2");
  const b2 = await jsonOf(r2);
  const item2 = itemOf(db2);
  check("L3-2", "等待分支证据一致 → 409 verifier_not_ready；blocked_draft；facts=0；无 employee_submitted",
    r2.status === 409 && b2.code === "verifier_not_ready"
      && item2.status === "blocked_draft" && item2.handoff_status === "waiting_assignment"
      && factsOf(db2).length === 0 && !eventsOf(db2).some((event) => event.type === "employee_submitted"),
    `${r2.status} ${b2.code || ""} status=${item2.status}`);
  db2.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── 旧判定重放：contentVersion 推进后旧判定不得恢复有效 ──");
{
  const db = fixture();
  const target = baselineOf(db)[0];
  tamperDraft(db, (draft) => {
    const entry = draft.ledger.authoritativeInferences.find((item) => item.id === target.id);
    entry.contentVersion = (Number.isInteger(entry.contentVersion) ? entry.contentVersion : 1) + 1;
    entry.evidenceHash = "EH-REPLAY-ADVANCED";
  });
  const before = snapshotOf(db);
  const replay = await submit(db, submissionBody(ANSWERS), "K-REPLAY-1");
  const replayBody = await jsonOf(replay);
  check("REPLAY-1", "推断内容版本已推进 → 库中旧判定 stale，提交 422 inferences_unjudged，零写入",
    replay.status === 422 && replayBody.code === "inferences_unjudged"
      && snapshotOf(db) === before,
    `${replay.status} ${replayBody.code || ""}`);
  const rejudge = await put(db, {
    answers: {}, materialStatus: "provided", baseRevision: revisionOf(db),
    inferenceVerdicts: echoVerdicts(baselineOf(db)),
  });
  const rejudgeBody = await jsonOf(rejudge);
  const ok = await submit(db, submissionBody(ANSWERS), "K-REPLAY-2");
  const okBody = await jsonOf(ok);
  check("REPLAY-2", "按当前版本重新确认 → 保存 accepted → 提交 200",
    rejudge.status === 200 && rejudgeBody.verdictResult.acceptedIds.length === baselineOf(db).length
      && ok.status === 200 && okBody.item?.status === "awaiting_verification",
    `rejudge=${rejudge.status} submit=${ok.status}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── 服务端契约：统一证据入口与门禁顺序（源码级检查）──");
{
  const submissionSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/employee-submission.js", import.meta.url), "utf8");
  const evidenceSrc = readFileSync(new URL("../functions/api/agent/_evidence.js", import.meta.url), "utf8");
  const draftSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/employee-draft.js", import.meta.url), "utf8");
  const turnSrc = readFileSync(new URL("../functions/api/agent/employee-turn.js", import.meta.url), "utf8");
  check("SRC-1", "统一证据入口 _evidence.js 导出 applyAnswerEvidence/applyEvidenceMutation/applyTurnEvidence/validateSubmissionEvidence",
    ["applyAnswerEvidence", "applyEvidenceMutation", "applyTurnEvidence", "validateSubmissionEvidence"].every((name) => evidenceSrc.includes(`export async function ${name}`) || evidenceSrc.includes(`export function ${name}`)),
    "exports ok");
  check("SRC-2", "employee-draft / employee-turn 都经统一入口写库（不各自实现证据规则）",
    draftSrc.includes("applyEvidenceMutation") && draftSrc.includes("applyAnswerEvidence") && turnSrc.includes("applyTurnEvidence"),
    "callers ok");
  check("SRC-3", "提交门禁在 F04 规范卡校验之后、任何写入之前调用 validateSubmissionEvidence",
    submissionSrc.indexOf('code: "card_evidence_mismatch"') < submissionSrc.indexOf("validateSubmissionEvidence({ draft: serverDraft")
      && submissionSrc.indexOf("validateSubmissionEvidence({ draft: serverDraft") < submissionSrc.indexOf("const submittedAt"),
    "order ok");
}

const failed = results.filter((entry) => entry.verdict === "FAIL");
console.log("\n──────────────── 结果明细 ────────────────");
for (const entry of results) {
  console.log(`  ${entry.verdict === "PASS" ? "✔" : "✘"} [${entry.verdict}] ${entry.id} · ${entry.name}${entry.note ? "\n        " + entry.note : ""}`);
}
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${results.length - failed.length}  FAIL=${failed.length}`);
if (failed.length) {
  console.error(`\n  IMPLEMENT-05B 定向套件失败 ${failed.length} 项：${failed.map((entry) => entry.id).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`  pilot09c implement-05b runtime: ok（${results.length} 项检查）`);
}
