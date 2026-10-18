/**
 * PILOT-09C/FIX-CODEX-02A —— F01 权威推断信任边界修复 · 定向运行时套件
 *
 * 覆盖 VERIFY-CODEX-01 已确认的 F01 攻击面与修复验收 A–G：
 *   A. 重放已确认攻击：ledger:{} + mode:"fixture" → 权威推断不减少，未判定提交继续 422。
 *   B. 伪造 authoritativeInferences=[] → 服务端不采信。
 *   C. 伪造旧版本权威推断 → 不得回滚/恢复旧判定。
 *   D. 伪造 burdenAsked / pendingQuestion / statementHistory → 不能覆盖服务端权威状态。
 *   E. 正常访谈与合法补正继续可用。
 *   F. 原有推断 ID 集合完整性（不因客户端请求减少）。
 *   G. 真实提交门禁：未判定 422；完成真实判定后 200。
 *
 * 服务端执行模式策略（F01 修复的一部分）：
 *   · 有 DEEPSEEK_API_KEY → 正式语义固定 harness（客户端 mode:"fixture" 被忽略）；
 *   · 无凭据 → 确定性 fixture 降级；显式 harness 请求 → 503；
 *   · 仅 FORMAL_AGENT_TEST_MODE=1（服务端测试配置）才允许客户端切到 fixture 测试档。
 *
 * 全部断言使用真实 handler + 内存 D1 + 服务端构建函数；不触网、不使用真实密钥。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { draftRevisionOf, normalizeEmployeeDraft, serializeEmployeeDraft } from "../functions/_shared.js";
import { ANSWER_DIMENSIONS as EVIDENCE_DIMENSIONS, canonicalJson as evidenceCanonicalJson, normalizeAnswers as evidenceNormalizeAnswers } from "../functions/api/agent/_evidence.js";
import { appendStatementHistory } from "../functions/api/agent/_adapter.js";
import { onRequestPost as agentTurn } from "../functions/api/agent/employee-turn.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { buildInferenceRecords, buildLedgerFromAnswers, resolveInferenceJudgment } from "../functions/api/agent/_adapter.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const KEY = "fake-deepseek-key-not-real-f01fix";   // 本地模拟模型；绝不触网
const P = "PRJ-F01FIX";
const ITEM = "WI-F01FIX";
const EMP = "ACC-F01-EMP";
const VER = "ACC-F01-VER";
const TOK = "TOK-F01-EMP";

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });
const check = (id, name, ok, note = "") => (ok ? pass(id, name, note) : fail(id, name, note));

const ANS = {
  trigger: "每天早上运营同事在群里发来当天的推广需求，我看到消息后开始处理",
  inputs: "先看昨天的曝光和点击数据，再看库存数量，然后确认投放预算还剩多少",
  steps: "先选品再写脚本，然后让剪辑同事剪出来，最后在后台提交审核并发布",
  judgments: "毛利率低于一成要先找主管确认，其他价格我自己按历史数据定",
  exceptions: "版权不确定就换同款，审核被拒就先改文案再重新提交",
  handoff: "剪完的素材交给投放同事小李，由他挂车和设置出价",
  burden: "一条视频从选题到发布大约需要三个小时，一周做五条左右",
};
const CARD = { ...ANS, materialIndex: "已提供近三个月的投放数据导出（已授权）" };

// ── PILOT-09C/IMPLEMENT-05B（F03）：服务端证据状态夹具 ───────────────────────
// F03 起正式提交要求 ledger.evidence / statementHistory 与答案一致，推断带
// evidenceVersion/evidenceRefs，判定回显 evidenceVersion。旧夹具只播种推断与判定。
// 这里用服务端构建函数生成与真实统一证据写入同构的状态（摘要用 node:crypto
// 按同一 SHA-256 算法独立计算），保持既有 revision/断言数值不变。
const evidenceSha256 = (value) => `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
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
    // 本套件多数用例需要"未判定"状态 → 未显式提供判定时保持 unjudged（不自动补判定）。
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

/** 服务端构建函数产出的可信记录（contentVersion / evidenceHash 由服务端计算） */
function trustedRecords(n = 4) {
  const defs = Array.from({ length: n }, (_, i) => ({
    source: "model",
    text: `F01 修复基线推断 ${i + 1}：服务端权威记录 ${i + 1}`,
    basis: "steps",
    assumes: "若与实际不符需更正",
  }));
  return buildInferenceRecords([], defs).records;
}

/**
 * 播种：合法项目 + 员工任务 + 指定草稿内容。
 * opts.answers 已保存答案；opts.records 已有权威基线；opts.verdicts 判定；
 * opts.burdenAsked / opts.statementHistory / opts.revision。
 */
function fixture(opts = {}) {
  const {
    answers = { trigger: ANS.trigger, inputs: ANS.inputs },
    records = [],
    verdicts = {},
    burdenAsked = false,
    statementHistory = [],
    revision = 0,
  } = opts;
  const db = new D1Harness();
  // F03：播种与真实统一证据写入同构的 evidence / statementHistory / 推断证据版本；
  // 传入的判定按服务端条目的当前版本回显（缺 evidenceVersion 的旧判定会被判 stale）。
  const evidenceSeed = seedEvidenceState({ answers, inferences: records, revision, verdicts, defaultVerdict: null });
  const draftHistory = Array.isArray(statementHistory) && statementHistory.length ? statementHistory : evidenceSeed.history;
  const draft = serializeEmployeeDraft({
    answers,
    ledger: {
      statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: evidenceSeed.evidence,
      authoritativeInferences: evidenceSeed.inferences, statementHistory: draftHistory, burdenAsked,
    },
    inferenceVerdicts: evidenceSeed.verdicts,
    submissionText: "",
    revision,
  });
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@f01fix.invalid','员工甲','active','member'),
      ('${VER}','ver@f01fix.invalid','核验人乙','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage)
      VALUES ('${P}','F01 修复验证','选品到发布','mapping','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P}','${EMP}','employee','project','active'),
      ('${P}','${VER}','verifier','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-F01FIX','${P}','授权','王总','o@f01fix.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key)
      VALUES ('INV-F01FIX-VER','inv-f01fix-ver','${P}','${EMP}','ver@f01fix.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','IK-F01FIX');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version)
      VALUES ('${ITEM}','${P}','还原工作','d','mapping','needs_input','employee','员工甲',0,'b','n','${EMP}','${VER}','${draft.replace(/'/g, "''")}','provided',1,1);
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token)
      VALUES ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R-F01FIX');
  `);
  return db;
}

const draftOf = (db) => normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
const revisionOf = (db) => draftRevisionOf(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
const baselineOf = (db) => draftOf(db).ledger?.authoritativeInferences || [];
const idsOf = (records) => records.map((entry) => entry && entry.id).filter(Boolean);
const revokedNone = (a, b) => a.every((id) => b.includes(id));

const originalFetch = globalThis.fetch;
/** 本地模型 stub：仅拦截 api.deepseek.com；返回给定 content（JSON 对象或原始字符串） */
function fakeModel(payload, capture = {}) {
  capture.prompts = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("api.deepseek.com")) return originalFetch(url, init);
    capture.prompts.push(JSON.parse(init.body).messages[0].content);
    const content = typeof payload === "function" ? payload(capture.prompts.length) : payload;
    const body = typeof content === "string" ? content : JSON.stringify(content);
    return new Response(JSON.stringify({ choices: [{ message: { content: body } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { capture, restore: () => { globalThis.fetch = originalFetch; } };
}
const Q = (key, label, prompt) => ({ turnKind: "question", question: { key, label, prompt } });

const turn = (db, body, envOverride = null) => agentTurn({
  request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", TOK, body),
  env: envOverride || { DB: db, FORMAL_AGENT_TEST_MODE: "1" },
  params: {},
});
const turnHarness = (db, body) => turn(db, body, { DB: db, DEEPSEEK_API_KEY: KEY });
const turnHarnessFixtureTier = (db, body) => turn(db, body, { DB: db, DEEPSEEK_API_KEY: KEY, FORMAL_AGENT_TEST_MODE: "1" });
const put = (db, body) => saveDraft({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, TOK, body),
  env: { DB: db }, params: { itemId: ITEM },
});
const submit = (db, body, key) => submitEmployee({
  // PILOT-09C/FIX-CODEX-03A：正式提交现在必须携带 baseRevision（测试按库中当前版本补齐）。
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK, { ...body, baseRevision: Number.isInteger(body.baseRevision) ? body.baseRevision : revisionOf(db) }, { "Idempotency-Key": key }),
  env: { DB: db }, params: { itemId: ITEM },
});
const jsonOf = async (response) => response.clone().json().catch(() => ({}));

// ── PILOT-09C/IMPLEMENT-05A（F04）：正式提交必须使用服务端规范卡/规范文本 ──
// 服务端规范值 = 已持久化草稿 answers + work_items.material_status；客户端载荷不一致即 422。
// 本套件的 G 组用例仍验证原提交门禁，只是提交载荷改由同一份答案按契约派生。
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

/** 服务端签发锚点（recover 路径，不调用模型）：返回 { key, revision, status } */
async function recoverAnchor(db, extra = {}) {
  const res = await turn(db, { projectId: P, workItemId: ITEM, recover: true, materialStatus: "provided", mode: "auto", baseRevision: revisionOf(db), ...extra });
  const body = await jsonOf(res);
  return { status: res.status, body, key: body?.turn?.nextQuestion?.key ?? draftOf(db).ledger?.pendingQuestion?.key ?? null, revision: revisionOf(db) };
}

const verdictEcho = (records, verdict = "agree", correction = "") => Object.fromEntries(records.map((entry) => [entry.id, {
  verdict, correction,
  contentVersion: entry.contentVersion,
  templateVersion: entry.templateVersion === undefined ? null : entry.templateVersion,
  evidenceHash: entry.evidenceHash || null,
  // F03：判定必须回显条目当前 evidenceVersion（旧回显会被拒绝，不再自动升级）。
  evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : 0,
}]));

console.log("PILOT-09C/FIX-CODEX-02A · F01 权威推断信任边界修复 —— 定向运行时套件\n");

// ═══════════════════════════════════════════════════════════════
console.log("── A. 重放已确认 F01 攻击：ledger:{} + mode:\"fixture\" ──");
{
  // A1：服务端无模型凭据（确定性 fixture 引擎）——攻击不得减少基线
  const db = fixture({ records: trustedRecords(4) });
  const before = idsOf(baselineOf(db));
  const anchor = await recoverAnchor(db);
  const attacked = await turn(db, {
    projectId: P, workItemId: ITEM, questionKey: anchor.key,
    answer: "补正：素材先发给投放群里小李确认，再挂车（攻击 A1）",
    answers: { ...ANS, [anchor.key]: "补正：素材先发给投放群里小李确认，再挂车（攻击 A1）" },
    ledger: {}, mode: "fixture", baseRevision: anchor.revision,
  }, { DB: db });
  const body = await jsonOf(attacked);
  const after = idsOf(baselineOf(db));
  check("A1-1", "攻击 A1 被服务端接受但权威基线**不减少**（无模型凭据路径）",
    attacked.status === 200 && revokedNone(before, after) && after.length >= before.length,
    `status=${attacked.status} 基线 ${before.length}→${after.length}`);
  // 未判定提交继续被拦截
  // IMPLEMENT-05A：正式提交要求服务端草稿 answers 完整；先补存完整答案（不改动基线/判定），
  // 再用服务端规范卡/文本提交，确保走到本用例要验证的 inferences_unjudged 门禁。
  await put(db, { answers: { ...ANS }, materialStatus: "provided", baseRevision: revisionOf(db) });
  const blocked = await submit(db, { text: canonicalText(ANS), workflowCard: canonicalCard(ANS, "provided"), materialStatus: "provided", inferences: [], inferenceVerdicts: {} }, "K-A1");
  const blockedBody = await jsonOf(blocked);
  check("A1-2", "攻击后未完成判定 → 正式提交仍被 422 inferences_unjudged 拦截",
    blocked.status === 422 && blockedBody.code === "inferences_unjudged",
    `${blocked.status} ${blockedBody.code || ""}`);
  db.close();
}
{
  // A2：服务端有模型凭据（正式语义）——客户端 mode:"fixture" 不得改变执行模式
  const db = fixture({ records: trustedRecords(4) });
  const before = idsOf(baselineOf(db));
  const anchor = await recoverAnchor(db);
  const fake = fakeModel(Q("steps", "实际怎么做", "请说明你实际的处理步骤"));
  let attacked; let captured = 0;
  try {
    attacked = await turnHarness(db, {
      projectId: P, workItemId: ITEM, questionKey: anchor.key,
      answer: "先选品再写脚本，然后让剪辑同事剪出来，最后在后台提交审核并发布",
      answers: { ...ANS, [anchor.key]: ANS.steps },
      ledger: {}, mode: "fixture", baseRevision: anchor.revision,
    });
    captured = fake.capture.prompts.length;
  } finally { fake.restore(); }
  const body = await jsonOf(attacked);
  const after = idsOf(baselineOf(db));
  check("A2-1", "正式语义下客户端 mode:\"fixture\" 被服务端忽略：实际执行 harness（模型被调用）",
    attacked.status === 200 && captured === 1 && body?.turn?.executionMode === "harness",
    `status=${attacked.status} mode=${body?.turn?.executionMode} modelCalls=${captured}`);
  check("A2-2", "A2 攻击后权威基线不减少", revokedNone(before, after) && after.length >= before.length,
    `基线 ${before.length}→${after.length}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── B. 伪造 authoritativeInferences=[] ──");
{
  const db = fixture({ records: trustedRecords(4) });
  const before = idsOf(baselineOf(db));
  const anchor = await recoverAnchor(db);
  const attacked = await turn(db, {
    projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "先看曝光点击和成交数据（B）",
    answers: { ...ANS, [anchor.key]: "先看曝光点击和成交数据（B）" },
    ledger: { authoritativeInferences: [] }, mode: "auto", baseRevision: anchor.revision,
  });
  const after = idsOf(baselineOf(db));
  check("B1", "伪造 authoritativeInferences=[] 被忽略：原 ID 集合完整保留",
    attacked.status === 200 && revokedNone(before, after) && after.length === before.length,
    `status=${attacked.status} 基线 ${before.length}→${after.length}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── C. 伪造旧版本权威推断（不得回滚/恢复旧判定）──");
{
  const records = trustedRecords(4);
  // F03：答案变化会**合法地**推进依赖该维度的推断 evidenceVersion（旧判定 stale）。
  // 模型无依赖建议时采用保守范围：新增 judgments 也必须使既有判定 stale，伪造旧基线不得恢复。
  const db = fixture({ answers: { trigger: ANS.trigger, inputs: ANS.inputs, steps: ANS.steps }, records, verdicts: verdictEcho(records) });
  const before = baselineOf(db);
  const anchor = await recoverAnchor(db);
  const forgedOld = records.map((entry) => ({
    ...entry,
    contentVersion: Math.max(0, entry.contentVersion - 1),
    evidenceHash: "EH-FORGED-OLD",
    quote: "客户端伪造的旧证据原文",
  }));
  const attacked = await turn(db, {
    projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "看库存和预算后再确认投放节奏（C）",
    answers: { ...ANS, [anchor.key]: "看库存和预算后再确认投放节奏（C）" },
    ledger: { authoritativeInferences: forgedOld }, mode: "fixture", baseRevision: anchor.revision,
  }, { DB: db, FORMAL_AGENT_TEST_MODE: "1" });
  const after = baselineOf(db);
  const versionsKept = before.every((old) => {
    const now = after.find((entry) => entry.id === old.id);
    return now && now.contentVersion === old.contentVersion && now.evidenceHash === old.evidenceHash;
  });
  const verdicts = draftOf(db).inferenceVerdicts;
  const oldVerdictsStale = before.every((old) => {
    const now = after.find((entry) => entry.id === old.id);
    return now && now.evidenceVersion === old.evidenceVersion + 1
      && resolveInferenceJudgment(now, verdicts) === "stale";
  });
  check("C1", "伪造旧版本推断被忽略：基线 contentVersion / evidenceHash 未被回滚",
    attacked.status === 200 && versionsKept, `status=${attacked.status} versionsKept=${versionsKept}`);
  check("C2", "新增保守依赖维度后旧判定 stale，伪造旧版本不能恢复判定", oldVerdictsStale,
    `oldVerdictsStale=${oldVerdictsStale}`);
  db.close();
}

// C3：证据版本已推进（旧判定 stale）后，伪造旧版本基线不得让旧判定恢复 valid
{
  const exceptionTemplate = buildInferenceRecords([], [{
    idSource: "template:exceptions:no-delete",
    source: "server_template",
    templateVersion: 1,
    quote: ANS.exceptions,
    text: `处理异常时「${ANS.exceptions}」——推断其中涉及的操作不会删除任何既有记录。`,
    basis: "exceptions",
    assumes: "若实际操作包含删除，这条必须更正。",
  }]).records;
  const oldEntry = exceptionTemplate[0];
  const db = fixture({ answers: { ...ANS }, records: exceptionTemplate, verdicts: verdictEcho(exceptionTemplate), burdenAsked: true });
  // 合法补正推进 exceptions 证据版本 1→2
  const supp = await recoverAnchor(db, { supplement: { dimension: "exceptions", intent: "correction" } });
  const fake = fakeModel({ turnKind: "draft", question: null, endingProposal: { recommended: true } });
  try {
    await turnHarness(db, {
      projectId: P, workItemId: ITEM, questionKey: supp.key,
      answer: "补正：版权不确定时先找法务确认，确认不了才换同款",
      answers: { ...ANS, exceptions: "补正：版权不确定时先找法务确认，确认不了才换同款" },
      mode: "harness", baseRevision: supp.revision,
    });
  } finally { fake.restore(); }
  const advanced = baselineOf(db).find((entry) => entry.id === oldEntry.id);
  const verdictOld = draftOf(db).inferenceVerdicts?.[oldEntry.id];
  const staleBefore = resolveInferenceJudgment(advanced, draftOf(db).inferenceVerdicts);
  // 攻击：伪造旧版本基线（cv1 + 旧哈希），尝试让旧判定恢复 valid
  const anchor = await recoverAnchor(db, { supplement: { dimension: "exceptions", intent: "supplement" } });
  const attacked = await turn(db, {
    projectId: P, workItemId: ITEM, questionKey: anchor.key,
    answer: "补正：版权问题先找法务，确认不了换素材",
    answers: { ...ANS, exceptions: "补正：版权问题先找法务，确认不了换素材" },
    ledger: { authoritativeInferences: [{ ...oldEntry, quote: ANS.exceptions, contentVersion: oldEntry.contentVersion, evidenceHash: oldEntry.evidenceHash }] },
    mode: "fixture", baseRevision: anchor.revision,
  }, { DB: db });
  const afterEntry = baselineOf(db).find((entry) => entry.id === oldEntry.id);
  const staleAfter = resolveInferenceJudgment(afterEntry, draftOf(db).inferenceVerdicts);
  check("C3", "证据版本推进后旧判定 stale；伪造旧版本基线无法让它恢复 valid",
    advanced.contentVersion >= 2 && staleBefore === "stale" && staleAfter === "stale"
      && attacked.status === 200 && afterEntry.contentVersion >= 2,
    `cv=${advanced.contentVersion} stateBefore=${staleBefore} stateAfter=${staleAfter} status=${attacked.status}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── D. 伪造 burdenAsked / pendingQuestion / statementHistory ──");
{
  const records = trustedRecords(3);
  const legitHistory = [{ seq: 1, dimension: "trigger", text: ANS.trigger, kind: "initial", turnRevision: 1, anchorKey: "trigger", at: "2026-10-17T00:00:00.000Z", supersedesSeq: null, source: "employee" }];
  const db = fixture({ records, burdenAsked: true, statementHistory: legitHistory });
  const anchor = await recoverAnchor(db);
  const attacked = await turn(db, {
    projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "每天早上先刷榜单找对标视频再定选题（D）",
    answers: { ...ANS, [anchor.key]: "每天早上先刷榜单找对标视频再定选题（D）" },
    ledger: {
      burdenAsked: false,
      pendingQuestion: { key: "burden", label: "伪造", prompt: "伪造", revision: 0, workItemId: "WI-OTHER" },
      statementHistory: [{ seq: 99, dimension: "steps", text: "客户端伪造历史", kind: "correction", source: "client" }],
    },
    mode: "fixture", baseRevision: anchor.revision,
  }, { DB: db });
  const stored = draftOf(db);
  const history = stored.ledger?.statementHistory || [];
  check("D1", "伪造 burdenAsked=false 被忽略：库中 burdenAsked 仍为 true",
    attacked.status === 200 && stored.ledger?.burdenAsked === true, `burdenAsked=${stored.ledger?.burdenAsked}`);
  check("D2", "伪造 pendingQuestion 被忽略：库中锚点仍是服务端签发（未出现 WI-OTHER / 伪造文本）",
    stored.ledger?.pendingQuestion?.workItemId !== "WI-OTHER"
      && !history.some((entry) => String(entry.text || "").includes("客户端伪造历史")),
    `anchorWorkItem=${stored.ledger?.pendingQuestion?.workItemId || "null"}`);
  check("D3", "伪造 statementHistory 被忽略：历史只追加服务端本轮记录（seq 连续、来源 employee）",
    history.length >= legitHistory.length + 1 && history.every((entry) => entry.source === "employee")
      && !history.some((entry) => entry.seq === 99),
    `history=${history.length}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── E. 正常访谈与合法补正继续可用 ──");
{
  // 基线：3 条模型记录 + 1 条 exceptions 模板记录（由服务端构建函数产出，含内容版本）
  const exceptionTemplate = buildInferenceRecords([], [{
    idSource: "template:exceptions:no-delete",
    source: "server_template",
    templateVersion: 1,
    quote: ANS.exceptions,
    text: `处理异常时「${ANS.exceptions}」——推断其中涉及的操作不会删除任何既有记录。`,
    basis: "exceptions",
    assumes: "若实际操作包含删除，这条必须更正。",
  }]).records;
  const db = fixture({ answers: { ...ANS }, records: [...trustedRecords(3), ...exceptionTemplate], burdenAsked: true });
  const supp = await recoverAnchor(db, { supplement: { dimension: "exceptions", intent: "correction" } });
  const suppBody = supp.body;
  check("E1", "合法补正通道仍可用：recover+supplement 正常签发补正锚点",
    supp.status === 200 && Boolean(supp.key) && suppBody?.turn?.supplement?.dimension === "exceptions",
    `status=${supp.status} anchor=${supp.key} supplement=${JSON.stringify(suppBody?.turn?.supplement)}`);
  const fake = fakeModel({ turnKind: "draft", question: null, endingProposal: { recommended: true, reason: "覆盖已满足" } });
  let answered;
  try {
    answered = await turnHarness(db, {
      projectId: P, workItemId: ITEM, questionKey: supp.key,
      answer: "补正：版权不确定时先找法务确认，确认不了才换同款，不再直接换",
      answers: { ...ANS, exceptions: "补正：版权不确定时先找法务确认，确认不了才换同款，不再直接换" },
      mode: "harness", baseRevision: supp.revision,
    });
  } finally { fake.restore(); }
  const stored = draftOf(db);
  const exc = baselineOf(db).find((entry) => entry.basis === "exceptions");
  const correction = (stored.ledger?.statementHistory || []).find((entry) => entry.kind === "correction");
  check("E2", "合法补正 turn 成功：陈述历史记录 correction、exceptions 推断内容版本推进（1→2）",
    answered.status === 200 && Boolean(correction) && exc
      && String(exc.quote || "").includes("先找法务确认") && Number(exc.contentVersion) >= 2,
    `status=${answered.status} cv=${exc?.contentVersion} correction=${Boolean(correction)} quote=${String(exc?.quote || "").slice(0, 24)}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── F. 原有推断 ID 集合完整性（连续攻击后）──");
{
  const db = fixture({ records: trustedRecords(5) });
  const before = idsOf(baselineOf(db));
  const attacks = [
    { ledger: {}, mode: "fixture" },
    { ledger: { authoritativeInferences: [] }, mode: "auto" },
    { ledger: { authoritativeInferences: baselineOf(db).map((entry) => ({ ...entry, contentVersion: 0 })) }, mode: "fixture" },
    { ledger: { burdenAsked: false, pendingQuestion: null, statementHistory: [] }, mode: "auto" },
  ];
  let statuses = [];
  let currentBefore = before;
  for (let i = 0; i < attacks.length; i += 1) {
    const anchor = await recoverAnchor(db);
    const res = await turn(db, {
      projectId: P, workItemId: ITEM, questionKey: anchor.key,
      answer: `连续攻击第 ${i + 1} 轮：先看曝光点击数据再确认投放预算和素材库存情况`,
      answers: { ...ANS, [anchor.key]: `连续攻击第 ${i + 1} 轮：先看曝光点击数据再确认投放预算和素材库存情况` },
      ledger: attacks[i].ledger, mode: attacks[i].mode, baseRevision: anchor.revision,
    }, { DB: db });
    statuses.push(res.status);
    const now = idsOf(baselineOf(db));
    if (!revokedNone(currentBefore, now)) { currentBefore = now; break; }
    currentBefore = now;
  }
  const finalIds = idsOf(baselineOf(db));
  check("F1", "连续 4 轮伪造 ledger / 模式攻击后，初始 5 个推断 ID 一个未少",
    statuses.every((status) => status === 200) && revokedNone(before, finalIds) && finalIds.length >= before.length,
    `statuses=${JSON.stringify(statuses)} 基线 ${before.length}→${finalIds.length}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── G. 真实提交门禁（未判定 → 422；真实判定后 → 200）──");
{
  const records = trustedRecords(4);
  const db = fixture({ answers: { ...ANS }, records, burdenAsked: true });
  // IMPLEMENT-05A：提交载荷 = 由草稿答案派生的服务端规范卡/规范文本。
  const blocked = await submit(db, { text: canonicalText(ANS), workflowCard: canonicalCard(ANS, "provided"), materialStatus: "provided", inferences: [], inferenceVerdicts: {} }, "K-G1");
  const blockedBody = await jsonOf(blocked);
  check("G1", "未判定时正式提交被 422 inferences_unjudged 拦截",
    blocked.status === 422 && blockedBody.code === "inferences_unjudged", `${blocked.status} ${blockedBody.code || ""}`);
  const currentRevision = revisionOf(db);
  // F03：从**服务端当前基线**回显版本（含 evidenceVersion）保存判定。
  const currentBaseline = baselineOf(db);
  const saved = await put(db, {
    answers: { ...ANS }, materialStatus: "provided", ledger: null,
    inferenceVerdicts: verdictEcho(currentBaseline), baseRevision: currentRevision,
  });
  const savedBody = await jsonOf(saved);
  const accepted = savedBody?.verdictResult?.acceptedIds || [];
  const ok = await submit(db, { text: canonicalText(ANS), workflowCard: canonicalCard(ANS, "provided"), materialStatus: "provided", inferences: [], inferenceVerdicts: {} }, "K-G2");
  const okBody = await jsonOf(ok);
  check("G2", "经服务端盖章保存真实判定后，正式提交通过（200 awaiting_verification）",
    saved.status === 200 && accepted.length === records.length && ok.status === 200
      && okBody?.item?.status === "awaiting_verification",
    `put=${saved.status} accepted=${accepted.length}/${records.length} submit=${ok.status}/${okBody?.item?.status || ""}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── 附加：服务端执行模式策略（隔离 harness / fixture 测试档）──");
{
  const db = fixture({ records: trustedRecords(2) });
  const anchor = await recoverAnchor(db);
  const noKeyHarness = await turn(db, {
    projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "先看曝光数据（M1）",
    answers: { ...ANS, [anchor.key]: "先看曝光数据（M1）" }, mode: "harness", baseRevision: anchor.revision,
  }, { DB: db });
  check("M1", "无模型凭据 + 显式 harness 请求 → 503（不得无密钥进入模型路径）",
    noKeyHarness.status === 503, `status=${noKeyHarness.status}`);
  db.close();
}
{
  const db = fixture({ records: trustedRecords(2) });
  const anchor = await recoverAnchor(db);
  const fake = fakeModel(Q("inputs", "先看什么", "你先看哪些信息？"));
  let res; let body; let calls = 0;
  try {
    res = await turnHarnessFixtureTier(db, {
      projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "先看曝光点击数据（M2）",
      answers: { ...ANS, [anchor.key]: "先看曝光点击数据（M2）" }, mode: "fixture", baseRevision: anchor.revision,
    });
    body = await jsonOf(res);
    calls = fake.capture.prompts.length;
  } finally { fake.restore(); }
  check("M2", "服务端测试配置（FORMAL_AGENT_TEST_MODE=1）下 fixture 测试档仍可用（不调用模型）",
    res.status === 200 && body?.turn?.executionMode === "fixture" && calls === 0,
    `status=${res.status} mode=${body?.turn?.executionMode} modelCalls=${calls}`);
  db.close();
}
{
  const db = fixture({ records: trustedRecords(2) });
  const anchor = await recoverAnchor(db);
  const fake = fakeModel(Q("inputs", "先看什么", "你先看哪些信息？"));
  let res; let body; let calls = 0;
  try {
    res = await turnHarness(db, {
      projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "先看曝光点击数据（M3）",
      answers: { ...ANS, [anchor.key]: "先看曝光点击数据（M3）" }, mode: "fixture", baseRevision: anchor.revision,
    });
    body = await jsonOf(res);
    calls = fake.capture.prompts.length;
  } finally { fake.restore(); }
  check("M3", "未开启测试档时客户端 mode:\"fixture\" 无法切换引擎（服务端仍执行 harness）",
    res.status === 200 && body?.turn?.executionMode === "harness" && calls === 1,
    `status=${res.status} mode=${body?.turn?.executionMode} modelCalls=${calls}`);
  db.close();
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
  console.error(`\n  F01 修复套件失败 ${failed.length} 项：${failed.map((entry) => entry.id).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("  pilot09c fix-codex-02a runtime: ok");
}
