/**
 * PILOT-09C-IMPLEMENT-2B —— 回归兼容与可信提交门禁
 *
 * 覆盖：
 *   §三 旧数据安全（不得自动补章 / 不得认定有效 / 阻止提交 / 可重新判定）
 *   §四 提交判定可信来源（库中持久化草稿，不信任请求体）
 *   §五 容量边界 A–F（可见 12 / 记录集 40 / 溢出保护）
 *   §六 服务端盖章、stale 阻断、溢出阻断、重复提交、并发版本一致性
 *
 * 全部走真实 handler + 内存 D1（node:sqlite）：不触网、不使用真实密钥。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";
import { ANSWER_DIMENSIONS as EVIDENCE_DIMENSIONS, canonicalJson as evidenceCanonicalJson, normalizeAnswers as evidenceNormalizeAnswers } from "../functions/api/agent/_evidence.js";
import { onRequestPost as agentTurn } from "../functions/api/agent/employee-turn.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { onRequestGet as readVerifierFacts } from "../functions/api/formal/projects/[projectId]/verifier-facts.js";
import { serializeEmployeeDraft, normalizeEmployeeDraft } from "../functions/_shared.js";
import {
  buildInferenceRecords, mergeAuthoritativeInferences, normalizeInference, resolveInferenceJudgment,
  appendStatementHistory, summarizeStatementHistory, normalizeStatementHistory, MAX_STATEMENT_HISTORY,
} from "../functions/api/agent/_adapter.js";

// §五 规定的容量上限（断言用字面量，不依赖实现内部常量）
const VISIBLE_LIMIT = 12;      // 员工可见/待判定列表上限
const RECORD_LIMIT = 40;       // 服务端记录集上限

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });
const check = (id, name, ok, note = "") => (ok ? pass(id, name, note) : fail(id, name, note));

const P = "PRJ-C9C", ITEM = "WI-C9C", EMP = "ACC-C9C-EMP", VER = "ACC-C9C-VER", EXT = "ACC-C9C-EXT";
const TOK = "TOK-C9C";
const CARD = {
  trigger: "每天早上先看后台的曝光和成交数据", inputs: "看曝光点击成交", steps: "选题然后剪辑然后发布",
  judgments: "毛利低于一成找主管确认", exceptions: "版权不确定就换同款",
  handoff: "剪完交给投放小李挂车", burden: "一条大概三小时", materialIndex: "有已授权材料",
};
// ── PILOT-09C/IMPLEMENT-05A（F04）：正式提交必须使用服务端规范卡/规范文本 ──
// 服务端只从**已持久化的草稿 answers + work_items.material_status** 派生 card/text；
// 客户端载荷与之不一致即 422。因此夹具草稿默认带完整七维答案，提交载荷由同一份
// 答案按契约派生（不是放宽断言：落库/门禁结果仍按原口径验证）。
const ANSWERS = {
  trigger: "每天早上先看后台的曝光和成交数据", inputs: "看曝光点击成交", steps: "选题然后剪辑然后发布",
  judgments: "毛利低于一成找主管确认", exceptions: "版权不确定就换同款",
  handoff: "剪完交给投放小李挂车", burden: "一条大概三小时",
};
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

// ── PILOT-09C/IMPLEMENT-05B（F03）：服务端证据状态夹具 ───────────────────────
// F03 起正式提交要求 ledger.evidence / statementHistory 与答案一致，推断带
// evidenceVersion/evidenceRefs，判定回显 evidenceVersion。旧夹具只播种推断与判定。
// 这里用服务端构建函数生成与真实统一证据写入同构的状态（摘要用 node:crypto
// 按同一 SHA-256 算法独立计算），既有 revision/断言数值不变。
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
    // PILOT-09C/G14：生成服务端同构的依赖元数据。模板固定依赖 basis；模型默认单 basis
    // 依赖（保持"不同维度不互相失效"的既有语义）；测试显式给出 evidenceRefs 时按显式依赖保留（跨维用例）。
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
      evidenceRefs: refs,
      dependencyRuleVersion: 1,
      dependencySource: isTemplate ? "server_template_fixed" : "server_rule",
      dependencyRuleStatus: isTemplate ? "server_template_fixed" : "model_rule_validated",
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
    // 显式提供的版本字段优先保留（本套件有"旧版本判定重放"夹具），否则取条目当前版本。
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

/** 用**真实服务端构建函数**产出可信记录（内容版本/签名由服务端计算，不手工伪造） */
const trustedRecords = (defs) => buildInferenceRecords([], defs).records;
// PILOT-09C/IMPLEMENT-05B（F03）：server_template 条目的 quote 必须与**当前答案**一致
// （服务端按当前 statements 确定性重建）。本套件用任意 quote（"证据一" 等）构造稳定 ID 的
// 推断夹具，并断言 quote/原文原样落库，因此夹具按 model 来源构造（quote 仅作证据引用，
// 不参与模板一致性校验）。断言（原文/quote/版本/判定语义）全部不变。
const tplDef = (idSource, quote, basis = "steps", assumes = "a") => ({
  idSource, source: "model", templateVersion: null, quote, text: `推断「${quote}」`, basis, assumes,
});
/** 服务端盖章的判定（模拟 employee-draft 已保存的结果） */
const stamp = (entry, verdict, correction = "") => ({
  verdict, correction,
  contentVersion: entry.contentVersion, templateVersion: entry.templateVersion, evidenceHash: entry.evidenceHash,
});

function fixture({ inferences = [], verdicts = {}, revision = 0, stage = "mapping", status = "needs_input", statementHistory = [], answers = ANSWERS } = {}) {
  const db = new D1Harness();
  // F03：播种与真实统一证据写入同构的 evidence / statementHistory / 推断证据版本。
  // 显式传入的 statementHistory 优先（部分用例模拟历史边界），其余按答案生成。
  const evidenceSeed = seedEvidenceState({ answers, inferences, revision, verdicts, defaultVerdict: null });
  const draftHistory = Array.isArray(statementHistory) && statementHistory.length ? statementHistory : evidenceSeed.history;
  const dj = serializeEmployeeDraft({
    answers, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: evidenceSeed.evidence, authoritativeInferences: evidenceSeed.inferences, statementHistory: draftHistory },
    inferenceVerdicts: evidenceSeed.verdicts, submissionText: "", revision,
  }).replace(/'/g, "''");
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@c9c.invalid','员工','active','member'),
      ('${VER}','ver@c9c.invalid','核验人','active','member'),
      ('${EXT}','ext@c9c.invalid','建设方','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage)
      VALUES ('${P}','C9C','范围','mapping','active','unknown','external_builder','${EXT}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P}','${EMP}','employee','project','active'),
      ('${P}','${VER}','verifier','project','active'),
      ('${P}','${EXT}','external_builder','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AU-C9C','${P}','授权','王总','o@c9c.invalid','只读','DOC','authorized','${EXT}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key)
      VALUES ('IV-C9C','it','${P}','${EXT}','ver@c9c.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','IK-C9C');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token)
      VALUES ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R1');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version)
      VALUES ('${ITEM}','${P}','还原工作','d','${stage}','${status}','employee','员工',0,'b','n','${EMP}','${VER}','${dj}','provided',1,1);
  `);
  return db;
}
const draftOf = (db) => normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
/** FIX-3B：构造带"版本回显"的判定载荷（回显来自服务端下发的条目） */
const echoVerdict = (entry, verdict, correction = "") => ({
  verdict, correction,
  contentVersion: Number.isInteger(entry.contentVersion) ? entry.contentVersion : null,
  templateVersion: entry.templateVersion === undefined ? null : entry.templateVersion,
  evidenceHash: entry.evidenceHash || null,
  // F03：判定必须回显条目当前 evidenceVersion（旧回显=旧判定，不再自动升级）。
  evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : 0,
});
/** FIX-3B：不带回显的"裸判定"（模拟旧客户端/重放） */
const bareVerdict = (verdict, correction = "", extra = {}) => ({ verdict, correction, ...extra });
const rowsOf = (db) => JSON.parse(db.get("SELECT alternative_explanations_json FROM work_items WHERE id=?", ITEM).alternative_explanations_json || "[]");
const SUB = (db, body, key = "KEY-C9C", env = { DB: db }) =>
  // PILOT-09C/FIX-CODEX-03A：正式提交现在必须携带 baseRevision（测试按库中当前版本补齐）。
  submitEmployee({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK, { ...body, baseRevision: Number.isInteger(body.baseRevision) ? body.baseRevision : draftOf(db).revision }, { "Idempotency-Key": key }), env, params: { itemId: ITEM } });
const PUT = (db, body) =>
  saveDraft({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, TOK, body), env: { DB: db }, params: { itemId: ITEM } });
const body = (extra = {}) => ({ text: canonicalText(ANSWERS), workflowCard: canonicalCard(ANSWERS, "provided"), materialStatus: "provided", ...extra });

// ═══════════════════════════════════════════════════════════════
console.log("── §三 旧数据安全 ──");
// A1：旧基线缺 contentVersion + 旧判定缺版本 → stale（不自动补章、不认定有效）
{
  const legacyEntry = { id: "INF-LEGACY", text: "旧基线推断", basis: "steps", assumes: "x" };   // 无版本字段
  const legacyVerdict = { verdict: "confirmed", correction: "" };                                // 无版本字段
  const state = resolveInferenceJudgment(legacyEntry, { "INF-LEGACY": legacyVerdict });
  check("C-A1", "旧数据缺版本信息 → 判定 stale（不自动补章、不自动认定有效）", state === "stale", `state=${state}`);
}
// A2：上述数据提交 → 被阻断
{
  const db = fixture({
    inferences: [{ id: "INF-LEGACY", text: "旧基线推断", basis: "steps", assumes: "x" }],
    verdicts: { "INF-LEGACY": { verdict: "confirmed", correction: "" } },
  });
  const r = await SUB(db, body());
  const b = await r.clone().json();
  check("C-A2", "旧数据提交被阻断（不得把旧判定当作已完成）", r.status === 422 && b.code === "inferences_unjudged", `${r.status} ${b.code}`);
  db.close();
}
// A3：必须能够**重新判定** → 经草稿端点盖章后提交成功
{
  const entry = trustedRecords([tplDef("template:a:steps", "旧基线推断")])[0];
  const db = fixture({ inferences: [entry], verdicts: {} });
  const put = await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [entry.id]: echoVerdict(entry, "agree") } });
  const r = await SUB(db, body());
  const b = await r.clone().json();
  check("C-A3", "旧数据可重新判定：草稿盖章后提交成功", put.status === 200 && r.status === 200, `put=${put.status} submit=${r.status} ${b.code || ""}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── §六.3 服务端盖章 ──");
// B1（FIX-3B 起）：伪造/缺失版本字段 → **拒绝盖章**（不再"丢弃后按库中值盖章"）
{
  const entry = trustedRecords([tplDef("template:a:steps", "证据一")])[0];
  const db = fixture({ inferences: [entry] });
  const forged = await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [entry.id]: bareVerdict("agree", "", { contentVersion: 777, templateVersion: 888, evidenceHash: "EH-FORGED" }) } });
  const forgedBody = await forged.clone().json();
  const storedAfterForge = draftOf(db).inferenceVerdicts[entry.id];
  const missing = await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 1, inferenceVerdicts: { [entry.id]: bareVerdict("agree") } });
  const missingBody = await missing.clone().json();
  check("C-B1", "伪造版本 → 不盖章（明确返回 version_mismatch）；缺失版本 → 不盖章（version_echo_required）",
    !storedAfterForge
      && forgedBody?.verdictResult?.rejected?.[0]?.reason === "version_mismatch"
      && missingBody?.verdictResult?.rejected?.[0]?.reason === "version_echo_required",
    JSON.stringify({ stored: storedAfterForge || null, forged: forgedBody?.verdictResult?.rejected?.[0]?.reason, missing: missingBody?.verdictResult?.rejected?.[0]?.reason }));
  // 正向对照：正确回显 → 盖章
  const ok = await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 2, inferenceVerdicts: { [entry.id]: echoVerdict(entry, "agree") } });
  const stored = draftOf(db).inferenceVerdicts[entry.id];
  check("C-B1b", "正确回显版本 → 盖章为服务端条目版本", ok.status === 200 && stored && stored.contentVersion === entry.contentVersion && stored.evidenceHash === entry.evidenceHash, JSON.stringify(stored));
  db.close();
}
// B2：判定变更 → history append（可审计），不无条件覆盖
{
  const entry = trustedRecords([tplDef("template:a:steps", "证据一")])[0];
  const db = fixture({ inferences: [entry] });
  await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [entry.id]: echoVerdict(entry, "agree") } });
  await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 1, inferenceVerdicts: { [entry.id]: echoVerdict(entry, "correct", "其实是版权") } });
  const stored = draftOf(db).inferenceVerdicts[entry.id];
  check("C-B2", "重新判定保留旧判定历史（可审计，不无条件覆盖）",
    stored.verdict === "corrected" && Array.isArray(stored.history) && stored.history.length === 1 && stored.history[0].verdict === "confirmed",
    JSON.stringify(stored.history));
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── §四 提交判定可信来源（F2）──");
// C1：请求体带完整判定但草稿为空 → 不得被采信
{
  const entry = trustedRecords([tplDef("template:a:steps", "证据一")])[0];
  const db = fixture({ inferences: [entry], verdicts: {} });
  const r = await SUB(db, body({ inferenceVerdicts: { [entry.id]: { verdict: "agree", contentVersion: entry.contentVersion, templateVersion: entry.templateVersion, evidenceHash: entry.evidenceHash } } }));
  const b = await r.clone().json();
  check("C-C1", "未保存的客户端判定不算已完成（请求体判定被忽略）", r.status === 422 && b.code === "inferences_unjudged", `${r.status} ${b.code}`);
  db.close();
}
// C2：草稿已盖章 → 提交成功，且落库判定取自草稿
{
  const entry = trustedRecords([tplDef("template:a:steps", "证据一")])[0];
  const db = fixture({ inferences: [entry], verdicts: { [entry.id]: stamp(entry, "corrected", "其实是版权") } });
  const r = await SUB(db, body({ inferenceVerdicts: { [entry.id]: { verdict: "agree" } } }));   // 请求体故意相反
  const rows = rowsOf(db);
  check("C-C2", "落库判定取自库中草稿（请求体的相反判定不生效）",
    r.status === 200 && rows.length === 1 && rows[0].verdict === "corrected" && rows[0].correction === "其实是版权",
    JSON.stringify(rows.map((x) => [x.verdict, x.correction])));
  db.close();
}
// C3：落库字段扩展（证据来源 / 版本 / 判定状态）
{
  const entry = trustedRecords([tplDef("template:a:steps", "证据一")])[0];
  const db = fixture({ inferences: [entry], verdicts: { [entry.id]: stamp(entry, "confirmed") } });
  await SUB(db, body());
  const row = rowsOf(db)[0] || {};
  check("C-C3", "落库保留 quote / evidenceHash / contentVersion / templateVersion / listed / judgmentState",
    row.quote === "证据一" && row.evidenceHash === entry.evidenceHash && row.contentVersion === entry.contentVersion
      && row.templateVersion === entry.templateVersion && row.listed === true && row.judgmentState === "valid",
    JSON.stringify({ quote: row.quote, cv: row.contentVersion, js: row.judgmentState }));
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── §六.5 stale 阻断 ──");
// D1/D2：证据版本推进 → 旧判定 stale → 阻断
// 注意：一次成功提交会把 assignee 换成核验人（既有行为），因此两个场景用**独立库**。
{
  const v1 = trustedRecords([tplDef("template:a:steps", "证据一")])[0];
  const db1 = fixture({ inferences: [v1], verdicts: { [v1.id]: stamp(v1, "confirmed") } });
  const ok = await SUB(db1, body(), "KEY-D1");
  db1.close();
  const v2 = mergeAuthoritativeInferences([v1], [tplDef("template:a:steps", "证据二")])[0];
  const db2 = fixture({ inferences: [v2], verdicts: { [v1.id]: stamp(v1, "confirmed") } });
  const r = await SUB(db2, body(), "KEY-D2");
  const b = await r.clone().json();
  check("C-D1", "版本一致时提交成功", ok.status === 200, `status=${ok.status}`);
  check("C-D2", "证据版本推进 → 旧判定 stale → 提交被阻断", r.status === 422 && b.code === "inferences_unjudged", `${r.status} ${b.code}`);
  check("C-D2b", "版本推进后 contentVersion 单调 +1", v2.contentVersion === v1.contentVersion + 1, `${v1.contentVersion} → ${v2.contentVersion}`);
  db2.close();
}
// D3：H1 → H2 → H1，旧判定不得自动恢复有效
{
  const h1 = trustedRecords([tplDef("template:a:steps", "证据一")])[0];
  const h2 = mergeAuthoritativeInferences([h1], [tplDef("template:a:steps", "证据二")])[0];
  const back = mergeAuthoritativeInferences([h2], [tplDef("template:a:steps", "证据一")])[0];
  const state = resolveInferenceJudgment(back, { [back.id]: stamp(h1, "confirmed") });
  check("C-D3", "证据 H1→H2→H1：版本继续推进，旧判定不得自动恢复有效",
    back.contentVersion === 3 && state === "stale", `version=${back.contentVersion} state=${state}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── §六.6 溢出阻断 ──");
// E1：溢出且未判定 → 专用错误码
{
  const defs = [0, 1, 2, 3].map((i) => tplDef(`template:d${i}:x`, `证据${i}`));
  const models = Array.from({ length: 14 }, (_, i) => ({ source: "model", text: `模型推断${i}`, basis: "steps", assumes: "a" }));
  const { list, records } = buildInferenceRecords([], [...defs, ...models]);
  const overflow = records.filter((e) => !e.listed);
  const db = fixture({ inferences: records, verdicts: {} });
  const r = await SUB(db, body());
  const b = await r.clone().json();
  check("C-E1", "溢出且未判定 → 422 inferences_overflow_pending（不得绕过门禁）",
    list.length === 12 && overflow.length === 6 && r.status === 422 && b.code === "inferences_overflow_pending",
    `list=${list.length} overflow=${overflow.length} status=${r.status} code=${b.code}`);
  db.close();
}
// E2：溢出但已判定 → 不因溢出阻断
{
  const defs = [0, 1, 2, 3].map((i) => tplDef(`template:d${i}:x`, `证据${i}`));
  const models = Array.from({ length: 14 }, (_, i) => ({ source: "model", text: `模型推断${i}`, basis: "steps", assumes: "a" }));
  const { records } = buildInferenceRecords([], [...defs, ...models]);
  const verdicts = Object.fromEntries(records.map((e) => [e.id, stamp(e, "confirmed")]));
  const db = fixture({ inferences: records, verdicts });
  const r = await SUB(db, body());
  check("C-E2", "溢出条目全部已判定 → 允许提交（溢出本身不阻断）", r.status === 200, `status=${r.status} 已判定=${Object.keys(verdicts).length}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── §六.7 重复提交 ──");
{
  const entry = trustedRecords([tplDef("template:a:steps", "证据一")])[0];
  const db = fixture({ inferences: [entry], verdicts: { [entry.id]: stamp(entry, "confirmed") } });
  const r1 = await SUB(db, body(), "KEY-DUP");
  const r2 = await SUB(db, body(), "KEY-DUP");
  const version = Number(db.get("SELECT submission_version FROM work_items WHERE id=?", ITEM).submission_version);
  const events = Number(db.get("SELECT COUNT(*) AS n FROM events WHERE work_item_id=? AND type='employee_submitted'", ITEM).n);
  // 重复提交不得产生第二次状态转换或第二条事件；被既有守卫（assignee 已转移 / 幂等）拒绝即可。
  check("C-F1", "重复提交不产生第二次写入（submission_version=1、事件仅 1 条）",
    r1.status === 200 && r2.status >= 400 && version === 1 && events === 1,
    `r1=${r1.status} r2=${r2.status} version=${version} events=${events}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── §六.8 并发版本一致性 ──");
{
  const entry = trustedRecords([tplDef("template:a:steps", "证据一")])[0];
  const db = fixture({ inferences: [entry], verdicts: { [entry.id]: stamp(entry, "confirmed") } });
  // 在"服务端读取草稿之后、执行 CAS 写入之前"插入一次并发草稿推进。
  // 必须拦截 batch（handler 把 UPDATE 放进 batch 执行），且 statements 必须是**真实**
  // D1Statement（D1Harness.runStatement 直接读取其 sql/values），因此用 Proxy 而非手写包装。
  let fired = false;
  const racyEnv = {
    DB: new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return (statements) => {
            if (!fired) {
              const d = JSON.parse(target.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json);
              d.revision = (d.revision || 0) + 5;   // 模拟并发轮次推进草稿
              target.exec(`UPDATE work_items SET employee_draft_json='${JSON.stringify(d).replace(/'/g, "''")}' WHERE id='${ITEM}'`);
              fired = true;
            }
            return target.batch(statements);
          };
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  const r = await SUB(db, body(), "KEY-RACE", racyEnv);
  const b = await r.clone().json();
  check("C-G1", "提交期间草稿被并发推进 → CAS 拒绝提交（不产生版本错配）",
    fired && r.status === 409 && b.code === "submission_conflict", `fired=${fired} status=${r.status} code=${b.code}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── §五 容量边界 A–F（IMPLEMENT-2C 修复后）──");
{
  // A：12 可见 / 18 记录 / 6 溢出
  const defs = [0, 1, 2, 3].map((i) => tplDef(`template:d${i}:x`, `证据${i}`));
  const models = Array.from({ length: 14 }, (_, i) => ({ source: "model", text: `模型推断${i}`, basis: "steps", assumes: "a" }));
  const { list, records } = buildInferenceRecords([], [...defs, ...models]);
  check("C-CAP-A", "容量 A：可见列表 12 / 记录集 18 / 溢出 6（上限未提高）",
    list.length === VISIBLE_LIMIT && records.length === 18 && records.filter((e) => !e.listed).length === 6,
    `list=${list.length} records=${records.length}`);
}
{
  // B：记录集达到硬上限 40（未触发阻塞：39→40 正常）
  const many = Array.from({ length: 60 }, (_, i) => ({ source: "model", text: `模型推断${i}`, basis: "steps", assumes: "a" }));
  const { list, records, capacity } = buildInferenceRecords([], many);
  check("C-CAP-B", "容量 B：记录集硬上限 40（可见列表仍 12，未因截断触发阻塞）",
    records.length === RECORD_LIMIT && list.length === VISIBLE_LIMIT && capacity.blocked === false,
    `list=${list.length} records=${records.length} blocked=${capacity.blocked}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── §五 CAP-01 ~ CAP-10（容量完整性）──");
const recN = (n) => buildInferenceRecords([], Array.from({ length: n }, (_, i) => ({ source: "model", text: `推断内容${i}用于占位测试`, basis: "steps", assumes: "a" }))).records;
const newInfer = (tag) => ({ source: "model", text: `全新推断${tag}用于容量测试`, basis: "steps", assumes: "a" });

// CAP-01：39 + 1 条不同推断 → 正常进入，达到 40
{
  const r39 = recN(39);
  const out = buildInferenceRecords(r39, [newInfer("A")]);
  check("CAP-01", "39 条 + 1 条不同推断 → 正常进入并达到 40 条（不触发阻塞）",
    out.records.length === RECORD_LIMIT && out.capacity.blocked === false && out.capacity.atCapacity === false,
    `records=${out.records.length} blocked=${out.capacity.blocked}`);
}
// CAP-02：40 + 1 条不同推断 → 原 40 条全部保留，不覆盖
{
  const r40 = recN(40);
  const ids40 = new Set(r40.map((e) => e.id));
  const out = buildInferenceRecords(r40, [newInfer("B")]);
  const kept = [...ids40].filter((id) => out.records.some((e) => e.id === id)).length;
  const newId = normalizeInference(newInfer("B")).id;
  check("CAP-02", "40 条 + 1 条不同推断 → 原 40 条全部保留、新推断不覆盖既有记录",
    kept === RECORD_LIMIT && !out.records.some((e) => e.id === newId) && out.capacity.blocked === true,
    `保留=${kept}/40 新推断进入=${out.records.some((e) => e.id === newId)} blocked=${out.capacity.blocked}`);
}
// CAP-03：40 + 1 条重复推断 → 不额外占位
{
  const r40 = recN(40);
  const dup = { source: "model", text: r40[0].text, basis: "steps", assumes: "a" };
  const out = buildInferenceRecords(r40, [dup]);
  check("CAP-03", "40 条 + 1 条重复推断 → 不额外占位、不触发阻塞",
    out.records.length === RECORD_LIMIT && out.capacity.blocked === false,
    `records=${out.records.length} blocked=${out.capacity.blocked}`);
}
// CAP-04：40 条中含已判定推断 → 判定与历史不得丢失
{
  const r40 = recN(40);
  const verdicts = Object.fromEntries(r40.map((e) => [e.id, stamp(e, "confirmed")]));
  const db = fixture({ inferences: r40, verdicts });
  const target = r40[0];
  await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [target.id]: echoVerdict(target, "correct", "更正内容") } });
  const stored = draftOf(db).inferenceVerdicts;
  const keptAll = r40.every((e) => stored[e.id] && stored[e.id].verdict);
  check("CAP-04", "40 条含已判定推断 → 判定与历史全部保留（重新判定保留 history）",
    keptAll && stored[target.id].verdict === "corrected" && Array.isArray(stored[target.id].history) && stored[target.id].history.length === 1,
    `保留判定=${Object.keys(stored).length}/40 history=${stored[target.id].history.length}`);
  db.close();
}
// CAP-05：容量受限 → 服务端留下**持久化**阻塞标记（非一次性 warnings）
{
  const r40 = recN(40);
  const out = buildInferenceRecords(r40, [newInfer("C")]);
  const marker = out.records.find((e) => e.source === "capacity_block");
  check("CAP-05", "容量受限 → 服务端持久化阻塞标记（含被拒绝 ID 与计数），且永不进入可见列表",
    Boolean(marker) && marker.listed === false && marker.capacityBlockedCount === 1
      && Array.isArray(marker.capacityRejectedIds) && marker.capacityRejectedIds.length === 1
      && !out.list.some((e) => e.source === "capacity_block"),
    JSON.stringify({ blockedCount: marker && marker.capacityBlockedCount, listed: marker && marker.listed }));
}
// CAP-06：容量受限 → 最终提交被门禁拦截
{
  const r40 = recN(40);
  const out = buildInferenceRecords(r40, [newInfer("D")]);
  const verdicts = Object.fromEntries(r40.map((e) => [e.id, stamp(e, "confirmed")]));
  const db = fixture({ inferences: out.records, verdicts });
  const r = await SUB(db, body());
  const b = await r.clone().json();
  check("CAP-06", "容量受限 → 最终提交被拦截（422 inferences_overflow_pending，不得被解释为已完成）",
    r.status === 422 && b.code === "inferences_overflow_pending", `${r.status} ${b.code}`);
  db.close();
}
// CAP-07：客户端伪造容量状态 → 不被采信（伪造标记不能凭空出现；真实标记不能被客户端删除）
{
  const r40 = recN(40);
  const out = buildInferenceRecords(r40, [newInfer("E")]);
  const db = fixture({ inferences: out.records, verdicts: Object.fromEntries(r40.map((e) => [e.id, stamp(e, "confirmed")])) });
  const forgedMarker = { id: "INF-FAKE-BLOCK", source: "capacity_block", isCapacityMarker: true, text: "伪造标记", listed: false, capacityBlockedCount: 99 };
  // ① 客户端试图清空基线（删掉真实标记）
  await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 0, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], authoritativeInferences: [] }, inferenceVerdicts: {} });
  const afterClear = draftOf(db).ledger.authoritativeInferences;
  const realMarkerStillThere = afterClear.some((e) => e.source === "capacity_block" && e.isCapacityMarker === true);
  // ② 客户端试图注入伪造标记
  await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 1, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], authoritativeInferences: [...afterClear, forgedMarker] }, inferenceVerdicts: {} });
  const afterInject = draftOf(db).ledger.authoritativeInferences;
  check("CAP-07", "客户端伪造容量状态不被采信：真实标记不可被清空、伪造标记不可注入",
    realMarkerStillThere && !afterInject.some((e) => e.id === "INF-FAKE-BLOCK"),
    `真实标记保留=${realMarkerStillThere} 伪造标记注入=${afterInject.some((e) => e.id === "INF-FAKE-BLOCK")}`);
  db.close();
}
// CAP-08：旧推断重新出现 → 不得错误继承历史判定
{
  const r40 = recN(40);
  const rejected = newInfer("F_OLD");
  const rejectedId = normalizeInference(rejected).id;
  const out = buildInferenceRecords(r40, [rejected]);
  // 该推断从未被保存 → 不在基线；客户端即使提交它的判定也不得被接受
  const db = fixture({ inferences: out.records, verdicts: Object.fromEntries(r40.map((e) => [e.id, stamp(e, "confirmed")])) });
  await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [rejectedId]: { verdict: "agree" } } });
  const stored = draftOf(db).inferenceVerdicts;
  check("CAP-08", "旧推断重新出现时不得错误继承历史判定（非基线 ID 的判定不被接受）",
    !out.records.some((e) => e.id === rejectedId) && !(rejectedId in stored),
    `在基线=${out.records.some((e) => e.id === rejectedId)} 判定入库=${rejectedId in stored}`);
  db.close();
}
// CAP-09：页面刷新 / 重复请求后容量阻塞仍然有效
{
  const r40 = recN(40);
  const out = buildInferenceRecords(r40, [newInfer("G")]);
  const db = fixture({ inferences: out.records, verdicts: Object.fromEntries(r40.map((e) => [e.id, stamp(e, "confirmed")])) });
  // 刷新 = 重新从库读取基线并重算；重复请求 = 同一状态再算一次
  const reloaded = draftOf(db).ledger.authoritativeInferences;
  const recheck1 = buildInferenceRecords(reloaded, []);          // 本轮没有新提议
  const recheck2 = buildInferenceRecords(reloaded, []);
  check("CAP-09", "刷新/重复请求后容量阻塞仍然有效（粘性，不因本轮无新提议而消失）",
    recheck1.capacity.blocked === true && recheck2.capacity.blocked === true
      && recheck1.records.some((e) => e.source === "capacity_block")
      && recheck1.capacity.blockedCount === out.capacity.blockedCount,
    `blocked=${recheck1.capacity.blocked} count=${recheck1.capacity.blockedCount}`);
  db.close();
}
// CAP-10：12 条可见列表契约保持不变
{
  const r40 = recN(40);
  const out = buildInferenceRecords(r40, [newInfer("H")]);
  const many = buildInferenceRecords([], Array.from({ length: 30 }, (_, i) => ({ source: "model", text: `模型推断${i}`, basis: "steps", assumes: "a" })));
  check("CAP-10", "可见列表契约保持 12 条（容量标记永不进入列表）",
    out.list.length === VISIBLE_LIMIT && many.list.length === VISIBLE_LIMIT
      && !out.list.some((e) => e.source === "capacity_block") && out.records.filter((e) => e.listed).length === VISIBLE_LIMIT,
    `list=${out.list.length}/${many.list.length}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── 边界：模型推断同样受内容版本保护 ──");
{
  const m1 = buildInferenceRecords([], [{ source: "model", text: "模型推断原始内容", basis: "steps", assumes: "a" }]).records[0];
  const m2 = buildInferenceRecords([m1], [{ source: "model", text: "模型推断改写后的内容", basis: "steps", assumes: "a" }]).records[0];
  const state = resolveInferenceJudgment(m2, { [m1.id]: stamp(m1, "confirmed") });
  check("C-M1", "模型推断内容变化 → 新条目（新 ID、版本 1），旧判定不套用",
    m1.id !== m2.id && state !== "valid", `id1=${m1.id} id2=${m2.id} state=${state}`);
  const same = buildInferenceRecords([m1], [{ source: "model", text: "模型推断原始内容", basis: "steps", assumes: "a" }]).records[0];
  check("C-M2", "模型推断无关格式变化不推进版本（不造成无意义重判）",
    same.contentVersion === m1.contentVersion, `${m1.contentVersion} → ${same.contentVersion}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── 端到端：真实 employee-turn 在容量已满时的持久化 ──");
{
  const recN = (n) => buildInferenceRecords([], Array.from({ length: n }, (_, i) => ({ source: "model", text: `推断内容${i}用于占位测试`, basis: "steps", assumes: "a" }))).records;
  const r40 = recN(40);
  const verdicts = Object.fromEntries(r40.map((e) => [e.id, stamp(e, "confirmed")]));
  // IMPLEMENT-05A：本段原语义是"容量已满时**一次模型调用**新提议恰好 1 条被拒→ count=1"。
  // 若夹具预置完整答案，服务端会同时确立确定性模板推断（4 条），count 会变成 5 ——
  // 那不是本段要验证的模型提议路径。因此本段保留"无员工答案"的原始前置，
  // 待模型轮结束后再按新契约补齐草稿答案（提交前要求 answers 完整），
  // 这样提交仍会命中容量溢出闸门而不是 answers_incomplete，原断言不被放宽。
  const db = fixture({ inferences: r40, verdicts, answers: {} });
  const CONTENT = JSON.stringify({
    turnKind: "question",
    question: { key: "inputs", label: "先看什么", prompt: "你先看哪些信息？" },
    proposedInferences: [{ text: "全新的模型推断X用于容量测试", basisDimension: "steps", assumes: "a" }],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: CONTENT } }] }), { status: 200, headers: { "content-type": "application/json" } });
  const KEY = "fake-key-not-real";
  const callTurn = (payload) => agentTurn({ request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", TOK, payload), env: { DB: db, DEEPSEEK_API_KEY: KEY }, params: {} });
  try {
    // ① 恢复路径先由服务端签发锚点（不跑模型）
    await callTurn({ projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "harness", baseRevision: 0 });
    const d0 = JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json);
    const anchor = d0.ledger.pendingQuestion;
    // ② 作答触发真实模型路径（假 fetch 提议一条**全新**推断）
    const r = await callTurn({ projectId: P, workItemId: ITEM, answers: { [anchor.key]: "每天早上先看后台曝光数据再挑对标视频" }, mode: "harness", baseRevision: d0.revision, questionKey: anchor.key });
    const b = await r.clone().json();
    const ledger = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json)).ledger;
    const baseline = ledger.authoritativeInferences;
    const marker = baseline.find((e) => e.source === "capacity_block");
    const warned = ((b.turn && b.turn.warnings) || []).some((w) => w.includes("推断记录集已达上限"));
    const keptAll = r40.every((e) => baseline.some((x) => x.id === e.id));
    // IMPLEMENT-05A：正式提交要求服务端草稿 answers 完整；在模型轮之后补齐（不改动已持久化的
    // 推断基线与容量标记），使提交仍走原用例要验证的"容量溢出 → 拦截"分支。
    const revisionAfterTurn = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json)).revision;
    await PUT(db, { answers: ANSWERS, materialStatus: "provided", baseRevision: revisionAfterTurn });
    const sr = await SUB(db, body());
    const sb = await sr.clone().json();
    check("CAP-E2E", "端到端：容量已满时一次真实模型调用 → 标记持久化于记录集首位、40 条全保留、响应警告可见、提交被拦截",
      r.status === 200 && Boolean(marker) && marker.listed === false && marker.capacityBlockedCount === 1
        && baseline[0] === marker && keptAll && warned && sr.status === 422 && sb.code === "inferences_overflow_pending",
      JSON.stringify({ status: r.status, marker: Boolean(marker), listed: marker && marker.listed, count: marker && marker.capacityBlockedCount, index: baseline.indexOf(marker), first: baseline[0] === marker, keptAll, warned, submit: `${sr.status} ${sb.code}` }));
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── IMPLEMENT-2D：前端证据与判定状态联动（U1–U7 契约）──");
{
  // 前端契约静态校验（与 pilot08c / pilot04b 同款范式）：只断言"存在且口径正确"，
  // 不替代浏览器验证，但能防住关键逻辑被回退。
  const APP = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const has = (needle) => APP.includes(needle);

  check("UI-U1", "U1 展示证据：条目渲染 quote（你的原话），无 quote 时明确声明不引用、不伪造",
    has("inf.quote") && has("你的原话：「") && has("该推断不引用你的原话（由 AI 归纳，没有员工原话证据）"),
    "quote 渲染与无引用声明");

  check("UI-U2", "U2 判定有效性：以服务端盖章 contentVersion/templateVersion 比对，stale 不计入已完成",
    has("function formalInferenceJudgmentState") && has("verdictVersion !== entryVersion")
      && has("templateVersion") && has("const judgedCount = inferenceSummary.valid"),
    "判定有效性规则 + 计数口径");

  check("UI-U3", "U3 过期提示：「依据已更新，请重新确认」可见，且 stale 单选框不预选",
    has("依据已更新，请重新确认") && has("stale 时单选框**不预选**"),
    "stale 提示");

  check("UI-U4", "U4 提交守卫：识别 valid/stale/unjudged 三态，不再用「verdict 存在=已判定」",
    has("const preflight = (() =>") && has("preflight.stale") && has("preflight.unjudged")
      && !has(".filter((inf) => !(state.formalInferenceVerdicts[inf.id] || {}).verdict)"),
    "提交守卫三态");

  check("UI-U5", "U5 汇总计数与 U2 同口径（updateInferenceSummary 使用 formalInferenceSummary）",
    has("function updateInferenceSummary") && has("formalInferenceSummary(formalVisibleInferences()"),
    "汇总口径一致");

  check("UI-U6", "U6 重新判定：本地只写 pending，权威状态以保存成功后的服务端返回为准",
    has("formalInferencePending") && has("applyServerInferenceVerdicts(result.task.draftInferenceVerdicts)")
      && has("state.formalInferencePending[id] = { verdict: event.target.value"),
    "pending → 服务端回写");

  check("UI-U7", "U7 核验侧：区分员工原话 / AI 推断来源 / 员工判定，且未判定不得当作事实",
    has("AI 推断 · 基于员工原话") && has("AI 推断 · 模型归纳（无员工原话）")
      && has("员工更正：") && has("员工尚未判定 —— 不得当作事实") && has("判定已过期"),
    "核验侧来源区分");

  check("UI-CAP", "§六 容量阻塞：明确提示「暂时无法提交，请联系管理员」，不提供清除操作，且提交按钮禁用",
    has("当前诊断存在未处理的推断，暂时无法提交，请联系管理员。")
      && has("本界面不提供清除操作") && has("存在未处理推断，暂不可提交"),
    "容量阻塞提示");

  check("UI-RESTORE", "§五 恢复路径保留服务端版本字段（quote/contentVersion/templateVersion/listed）",
    has("quote: entry.quote || null") && has("contentVersion: Number.isInteger(entry.contentVersion)")
      && has("templateVersion: Number.isInteger(entry.templateVersion)") && has("listed: entry.listed !== false"),
    "版本字段镜像");

  check("UI-NOFORGE", "§五 客户端**回显**版本但不自我认证：版本取自服务端下发条目，有效性仍由服务端裁决",
    has("function formalVerdictsPayload")
      && has("contentVersion: Number.isInteger(target.contentVersion) ? target.contentVersion : null")
      && has("evidenceHash: target.evidenceHash || null")
      && has("applyServerInferenceVerdicts(result.task.draftInferenceVerdicts)"),
    "回显源 = state.formalAgentInferences（服务端下发）");

  check("UI-SAVEFIRST", "§七-7 未保存判定不能提交：提交前先落库判定，失败则不提交",
    has("const flushed = await persistFormalEmployeeDraftNow({ verdictsOnly: true })")
      && has("判定尚未保存成功，请重试后再提交。"),
    "提交前保存");
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── FIX-2F：D-1 保存链路 / D-2 过期判定展示（页面交互级回归）──");
{
  const APP = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const saveCalls = (APP.match(/inferenceVerdicts: formalVerdictsPayload\(\)/g) || []).length;
  check("UI-D1", "D-1 保存草稿必须合并「待保存判定」（不得再直接发 formalInferenceVerdicts）",
    saveCalls >= 2 && !APP.includes("inferenceVerdicts: state.formalInferenceVerdicts"),
    `formalVerdictsPayload 调用点=${saveCalls}（保存 + 提交）`);
  check("UI-D1-PAYLOAD", "D-1/FIX-3B 判定载荷：只发待保存判定，且 contentVersion/templateVersion/evidenceHash 三项回显齐全",
    APP.includes("const pending = state.formalInferencePending || {};")
      && APP.includes("contentVersion: Number.isInteger(target.contentVersion) ? target.contentVersion : null")
      && APP.includes("templateVersion: target.templateVersion === undefined ? null : target.templateVersion")
      && APP.includes("evidenceHash: target.evidenceHash || null"),
    "formalVerdictsPayload = pending + 三项回显");
}
{
  // D-2 行为级验证：把 app.js 中的 formalInferenceJudgmentState 原样取出在 Node 中执行，
  // 用最小 state 桩模拟"过期判定已移出有效镜像、仅保留在 prior 表"的真实恢复态。
  const APP = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const src = APP.slice(APP.indexOf("function formalInferenceJudgmentState"), APP.indexOf("function formalInferenceCapacityMarker"));
  const factory = new Function("state", "formalIsCapacityMarker", `${src}; return formalInferenceJudgmentState;`);
  const fakeState = { formalInferencePriorVerdicts: {} };
  const judge = factory(fakeState, (e) => Boolean(e && (e.source === "capacity_block" || e.isCapacityMarker === true)));
  const entryV2 = { id: "INF-A", source: "server_template", contentVersion: 2, templateVersion: 1 };
  const entryV1 = { id: "INF-B", source: "server_template", contentVersion: 1, templateVersion: 1 };
  const staleV1 = { verdict: "agree", contentVersion: 1, templateVersion: 1 };

  // ① 过期判定被移出有效镜像、只存在于 prior 表 → 必须 stale（D-2 核心）
  fakeState.formalInferencePriorVerdicts = { "INF-A": staleV1 };
  const onlyPrior = judge(entryV2, {}, fakeState.formalInferencePriorVerdicts);
  // ② 既无有效判定也无过期判定 → unjudged
  const none = judge({ id: "INF-C", source: "model", contentVersion: 1, templateVersion: null }, {}, {});
  // ③ 版本一致 → valid
  const valid = judge(entryV1, { "INF-B": staleV1 }, {});
  // ④ 版本不一致（仍在镜像中）→ stale
  const mismatch = judge(entryV2, { "INF-A": staleV1 }, {});
  // ⑤ 容量标记 → capacity_block
  const marker = judge({ id: "INF-CAP", source: "capacity_block" }, {}, {});
  check("UI-D2", "D-2 过期判定仅存于 prior 表时必须仍判为 stale（不得退回 unjudged）", onlyPrior === "stale", `state=${onlyPrior}`);
  check("UI-D2-CASES", "D-2 其余判定态不回归（unjudged / valid / stale / capacity_block）",
    none === "unjudged" && valid === "valid" && mismatch === "stale" && marker === "capacity_block",
    JSON.stringify({ none, valid, mismatch, marker }));
  check("UI-D2-NOPRESELECT", "D-2 stale 行单选框不预选（必须重新表态才可保存）",
    APP.includes('const effective = pending || (jstate === "valid" ? verdicts[inf.id] : null);'),
    "effective 仅取 pending 或 valid 判定");
  check("UI-D2-HINT", "D-2 保留「上次判定」提示与「依据已更新，请重新确认」文案",
    APP.includes("上次判定：") && APP.includes("依据已更新，请重新确认"),
    "过期展示信息");
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── FIX-3B：S-1 判定版本绑定与重放防护（T1–T6 / T11 / T12）──");
{
  const base = trustedRecords([tplDef("template:a:steps", "旧证据")])[0];
  // 证据升级：同一模板条目 contentVersion → 2
  const v2 = mergeAuthoritativeInferences([base], [tplDef("template:a:steps", "新证据")])[0];
  const v1Verdict = { verdict: "confirmed", correction: "", contentVersion: base.contentVersion, templateVersion: base.templateVersion, evidenceHash: base.evidenceHash, history: [] };

  // T1：旧判定 v1 → 新证据 v2 → 重放 v1（回显 v1）
  const db1 = fixture({ inferences: [v2], verdicts: { [v2.id]: v1Verdict } });
  const r1 = await PUT(db1, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [v2.id]: bareVerdict("agree", "", { contentVersion: v1Verdict.contentVersion, templateVersion: v1Verdict.templateVersion, evidenceHash: v1Verdict.evidenceHash }) } });
  const b1 = await r1.clone().json();
  const s1 = draftOf(db1).inferenceVerdicts[v2.id];
  check("T1", "旧判定 v1 在新证据 v2 下重放 → 不盖章，库中仍是 v1（保持 stale）",
    r1.status === 200 && s1.contentVersion === v1Verdict.contentVersion && b1?.verdictResult?.rejected?.[0]?.reason === "version_mismatch",
    JSON.stringify({ storedCv: s1.contentVersion, rejected: b1?.verdictResult?.rejected?.[0]?.reason }));
  db1.close();

  // T2：显式伪造旧版本字段
  const db2 = fixture({ inferences: [v2], verdicts: {} });
  const r2 = await PUT(db2, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [v2.id]: bareVerdict("agree", "", { contentVersion: 1, templateVersion: 1, evidenceHash: "EH-FORGED" }) } });
  const b2 = await r2.clone().json();
  check("T2", "显式伪造旧版本字段 → 拒绝（不产生判定）", !draftOf(db2).inferenceVerdicts[v2.id] && b2?.verdictResult?.rejected?.length === 1, JSON.stringify(b2?.verdictResult?.rejected?.[0]?.reason));
  db2.close();

  // T3：缺失版本字段
  const db3 = fixture({ inferences: [v2], verdicts: {} });
  const r3 = await PUT(db3, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [v2.id]: bareVerdict("agree") } });
  const b3 = await r3.clone().json();
  check("T3", "缺失版本字段 → 拒绝（version_echo_required）", !draftOf(db3).inferenceVerdicts[v2.id] && b3?.verdictResult?.rejected?.[0]?.reason === "version_echo_required", JSON.stringify(b3?.verdictResult?.rejected?.[0]?.reason));
  db3.close();

  // T4：正确版本的合法新确认
  const db4 = fixture({ inferences: [v2], verdicts: { [v2.id]: v1Verdict } });
  const r4 = await PUT(db4, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [v2.id]: echoVerdict(v2, "agree") } });
  const b4 = await r4.clone().json();
  const s4 = draftOf(db4).inferenceVerdicts[v2.id];
  check("T4", "正确回显 → 盖章为 v2 有效判定（合法重新确认成功）", r4.status === 200 && s4.contentVersion === v2.contentVersion && (b4?.verdictResult?.rejected || []).length === 0, JSON.stringify(s4));
  db4.close();

  // T5：同版本同判定重复保存 → 幂等
  const db5 = fixture({ inferences: [v2], verdicts: { [v2.id]: { verdict: "confirmed", correction: "", contentVersion: v2.contentVersion, templateVersion: v2.templateVersion, evidenceHash: v2.evidenceHash, history: [] } } });
  const r5a = await PUT(db5, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [v2.id]: echoVerdict(v2, "agree") } });
  const r5b = await PUT(db5, { answers: {}, materialStatus: "provided", baseRevision: 1, inferenceVerdicts: { [v2.id]: echoVerdict(v2, "agree") } });
  const s5 = draftOf(db5).inferenceVerdicts[v2.id];
  check("T5", "同版本同判定重复保存 → 幂等（不新增 history、不改变版本）", r5a.status === 200 && r5b.status === 200 && s5.contentVersion === v2.contentVersion && (s5.history || []).length === 0, JSON.stringify({ cv: s5.contentVersion, history: s5.history }));
  db5.close();

  // T6：H1→H2→H1 版本单调递增
  const h2 = mergeAuthoritativeInferences([v2], [tplDef("template:a:steps", "旧证据")])[0];
  check("T6", "证据 H1→H2→H1：版本 1→2→3 单调递增（旧判定不自动恢复）",
    base.contentVersion === 1 && v2.contentVersion === 2 && h2.contentVersion === 3 && resolveInferenceJudgment(h2, { [h2.id]: v1Verdict }) === "stale",
    JSON.stringify({ v1: base.contentVersion, v2: v2.contentVersion, v3: h2.contentVersion }));

  // T11：多条判定混合有效/无效版本 → 逐项结果
  const e2 = trustedRecords([tplDef("template:b:exceptions", "另一条")])[0];
  const db11 = fixture({ inferences: [v2, e2], verdicts: {} });
  const r11 = await PUT(db11, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [v2.id]: echoVerdict(v2, "agree"), [e2.id]: bareVerdict("agree", "", { contentVersion: 99, templateVersion: 99, evidenceHash: "EH-X" }) } });
  const b11 = await r11.clone().json();
  const stored11 = draftOf(db11).inferenceVerdicts;
  check("T11", "混合批次：有效项落库、无效项逐项拒绝（无静默部分成功）",
    Boolean(stored11[v2.id]) && !stored11[e2.id] && b11?.verdictResult?.rejected?.length === 1,
    JSON.stringify({ accepted: Object.keys(stored11), rejected: (b11?.verdictResult?.rejected || []).map((x) => x.id) }));
  db11.close();

  // T12：旧数据缺版本信息 → 安全失败（不盖章）
  const legacyEntry = { id: "INF-LEGACY", text: "旧基线推断", basis: "steps", assumes: "x" };
  const db12 = fixture({ inferences: [legacyEntry], verdicts: {} });
  const r12 = await PUT(db12, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { "INF-LEGACY": bareVerdict("agree") } });
  const b12 = await r12.clone().json();
  check("T12", "旧数据缺版本信息 → 安全失败（不盖章、明确拒绝）", !draftOf(db12).inferenceVerdicts["INF-LEGACY"] && b12?.verdictResult?.rejected?.length === 1, JSON.stringify(b12?.verdictResult?.rejected?.[0]?.reason));
  db12.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── IMPLEMENT-3D：H-1 员工陈述历史保全（H1–H10）──");
{
  const append = (history, dimension, text, intent = "", revision = 1) =>
    appendStatementHistory({ prior: history, dimension, text, intent, revision, anchorKey: dimension });
  const kinds = (history) => history.map((e) => e.kind);

  // H1：第一次回答正常记录（含可追溯来源）
  const h1 = append([], "exceptions", "不能拍的就跳过不记").history;
  check("H1", "H1 首次回答记录为 initial，并绑定轮次/锚点/来源",
    h1.length === 1 && h1[0].kind === "initial" && h1[0].turnRevision === 1
      && h1[0].anchorKey === "exceptions" && h1[0].source === "employee" && Number.isInteger(h1[0].seq),
    JSON.stringify(h1[0]));

  // H2：同维度第二次回答，第一条仍保留
  const h2 = append(h1, "exceptions", "版权不确定就先备份再改").history;
  check("H2", "H2 同维度第二次回答 → 追加 supplement，第一条原话仍完整保留",
    h2.length === 2 && h2[0].text === "不能拍的就跳过不记" && h2[1].kind === "supplement"
      && h2[1].text === "版权不确定就先备份再改",
    JSON.stringify(h2.map((e) => [e.seq, e.kind, e.text])));

  // H3：先说"不知道"，后来补充 —— 原始"不知道"仍可追溯
  let h3 = append([], "handoff", "这个我不知道").history;
  h3 = append(h3, "handoff", "剪完发给投放小李").history;
  const h3sum = summarizeStatementHistory(h3);
  check("H3", "H3 先说「不知道」→ 后补充：unknown 条目永久保留且可被摘要识别",
    h3.length === 2 && h3[0].kind === "unknown" && h3[0].text === "这个我不知道"
      && h3[1].kind === "supplement" && h3sum.byDimension.handoff.unknownStated === true,
    JSON.stringify({ kinds: kinds(h3), unknownStated: h3sum.byDimension.handoff.unknownStated }));

  // H4：明确纠正 —— 原话与更正关系均保留
  let h4 = append([], "steps", "先剪辑再选题").history;
  h4 = append(h4, "steps", "我之前说反了，其实先选题再剪辑", "correction").history;
  check("H4", "H4 明确纠正：原话保留 + 记录 correction 与 supersedesSeq（纠正关系链）",
    h4.length === 2 && h4[0].text === "先剪辑再选题" && h4[1].kind === "correction"
      && h4[1].supersedesSeq === h4[0].seq,
    JSON.stringify(h4.map((e) => [e.seq, e.kind, e.supersedesSeq, e.text])));

  // H5：两次回答矛盾 —— 不自动把后者当正确答案；纯文本差异也不得判为 correction
  let h5 = append([], "judgments", "没有异常需要处理").history;
  h5 = append(h5, "judgments", "有异常每天都要报备给主管").history;
  let h5b = append([], "inputs", "看播放量").history;
  h5b = append(h5b, "inputs", "还会看评论区的反馈和成交转化").history;
  check("H5", "H5 矛盾 → conflict_pending（不自动裁决）；纯文本差异 → supplement（不判为纠正）",
    h5.length === 2 && h5[1].kind === "conflict_pending" && h5b[1].kind === "supplement"
      && !kinds(h5).includes("correction") && !kinds(h5b).includes("correction"),
    JSON.stringify({ conflict: kinds(h5), plainDiff: kinds(h5b) }));

  // H7：历史不可变（传入数组不被原地修改）且可完整序列化/往返（刷新后仍在）
  const snapshot = JSON.stringify(h2);
  const h7 = append(h2, "exceptions", "还要补一句：旧链接也留着").history;
  const roundTrip = normalizeStatementHistory(JSON.parse(JSON.stringify(h7)));
  check("H7", "H7 历史 append-only：先前数组不被原地修改，且 JSON 往返后完全一致（刷新可恢复）",
    JSON.stringify(h2) === snapshot && JSON.stringify(roundTrip) === JSON.stringify(h7),
    JSON.stringify({ before: JSON.parse(snapshot).length, after: h7.length }));

  // H9：容量上限 —— 显式阻塞，不静默截断
  const VALID_DIMS = ["trigger", "inputs", "steps", "judgments", "exceptions", "handoff", "burden"];
  let full = [];
  for (let i = 0; i < MAX_STATEMENT_HISTORY; i += 1) full = append(full, VALID_DIMS[i % 7], `第 ${i} 条陈述内容`).history;
  const overflow = appendStatementHistory({ prior: full, dimension: "steps", text: "再补一条", revision: 1 });
  check("H9", "H9 历史达硬上限 → 返回 overflow（调用方显式阻塞），不静默丢弃/截断旧条目",
    full.length === MAX_STATEMENT_HISTORY && overflow.overflow === true
      && overflow.history.length === MAX_STATEMENT_HISTORY,
    JSON.stringify({ limit: MAX_STATEMENT_HISTORY, gained: overflow.history.length }));

  // H6/H7b/H8：经**真实 employee-draft handler** 校验服务端专属语义
  const seeded = h2;
  const seededJson = JSON.stringify(seeded);
  const db = fixture({ inferences: [trustedRecords([tplDef("template:a:steps", "证据一")])[0]], statementHistory: seeded });
  const seededInDb = JSON.stringify(draftOf(db).ledger?.statementHistory || []);
  check("H6-pre", "H6-pre 测试夹具已把历史写入草稿（前置）", seededInDb === seededJson, `stored=${JSON.parse(seededInDb).length}`);
  // H6：客户端伪造/删除历史 → 一律不采信
  const forged = [{ seq: 99, dimension: "steps", text: "伪造的历史", kind: "initial", source: "employee" }];
  await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 0, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], statementHistory: forged }, inferenceVerdicts: {} });
  const afterForge = draftOf(db).ledger?.statementHistory || [];
  check("H6", "H6 客户端伪造/删除 statementHistory → 服务端丢弃，库中原历史原样保留",
    JSON.stringify(afterForge) === seededJson,
    JSON.stringify({ sent: forged.length, stored: afterForge.length }));
  // H7b：再次保存（不携带历史）→ 历史仍被结转（不会被"没发就清空"）
  await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 1, inferenceVerdicts: {} });
  check("H7b", "H7b 后续保存未携带历史 → 服务端结转，历史不丢失",
    JSON.stringify(draftOf(db).ledger?.statementHistory || []) === seededJson, `stored=${(draftOf(db).ledger?.statementHistory || []).length}`);
  // H8：并发过期写入被拒，历史不被覆盖
  const conflictPut = await PUT(db, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: {} });
  check("H8", "H8 并发/过期 baseRevision 写入被拒（409），历史不被覆盖",
    conflictPut.status === 409 && JSON.stringify(draftOf(db).ledger?.statementHistory || []) === seededJson,
    `${conflictPut.status}`);
  db.close();

  // H10：判定版本保护不回归（旧版本重放仍不得盖章）
  const e2 = mergeAuthoritativeInferences([], [tplDef("template:a:steps", "证据一")])[0];
  const db10 = fixture({ inferences: [e2], verdicts: { [e2.id]: { verdict: "confirmed", correction: "", contentVersion: 1, templateVersion: 1, evidenceHash: "EH-OLD", history: [] } } });
  const replay = await PUT(db10, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { [e2.id]: { verdict: "agree", correction: "", contentVersion: 1, templateVersion: 1, evidenceHash: "EH-OLD" } } });
  const replayBody = await replay.clone().json();
  const stored10 = draftOf(db10).inferenceVerdicts[e2.id];
  check("H10", "H10 判定版本保护不回归：旧版本重放仍被拒绝、库中判定不被重新盖章",
    replayBody?.verdictResult?.rejected?.length === 1 && stored10.contentVersion === 1,
    JSON.stringify({ rejected: replayBody?.verdictResult?.rejected?.[0]?.reason, storedCv: stored10.contentVersion }));
  db10.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── IMPLEMENT-3F：正式提交审计快照完整性（AUD-01～10）──");
{
  const entry = trustedRecords([tplDef("template:a:steps", "证据一"), tplDef("template:b:exceptions", "证据二")]);
  const verdicts = Object.fromEntries(entry.map((e) => [e.id, stamp(e, "confirmed")]));
  let hist = [];
  for (const dim of ["trigger", "inputs", "steps", "judgments", "exceptions", "handoff", "burden"]) {
    hist = appendStatementHistory({ prior: hist, dimension: dim, text: `我的回答-${dim}`, revision: hist.length }).history;
  }
  const eventsOf = (db) => db.all("SELECT payload, created_at FROM events WHERE type='employee_submitted' ORDER BY created_at ASC, id ASC")
    .map((row) => { try { return JSON.parse(row.payload); } catch { return null; } }).filter(Boolean);
  // PILOT-09C/IMPLEMENT-05B（F03）：证据门禁要求 statementHistory 最新陈述与答案一致。
  // 本组夹具的历史是"我的回答-<dim>"，因此草稿答案也用同一组文本（历史边界/版本断言不变）。
  const AUD_ANSWERS = Object.fromEntries(hist.map((entry) => [entry.dimension, entry.text]));
  const audBody = (extra = {}) => ({ text: canonicalText(AUD_ANSWERS), workflowCard: canonicalCard(AUD_ANSWERS, "provided"), materialStatus: "provided", ...extra });
  const makeDb = () => fixture({ answers: AUD_ANSWERS, inferences: entry, verdicts, revision: 10, statementHistory: hist });

  // AUD-01：首次提交保存完整快照
  const db1 = makeDb();
  const r1 = await SUB(db1, audBody({}), "AUD-K1");
  const ev1 = eventsOf(db1);
  const snap1 = ev1[0];
  check("AUD-01", "AUD-01 首次提交保存完整快照（版本/推断/判定/历史边界）",
    r1.status === 200 && ev1.length === 1 && snap1.submissionVersion === 1
      && Array.isArray(snap1.inferences) && snap1.inferences.length === entry.length
      && Array.isArray(snap1.verdicts) && snap1.verdicts.length === entry.length
      && snap1.statementHistorySeq === Math.max(...hist.map((e) => e.seq)) && snap1.statementHistoryCount === hist.length
      && snap1.source === "server_employee_submission" && Boolean(snap1.submittedAt) && snap1.workItemId === ITEM,
    JSON.stringify({ v: snap1.submissionVersion, inf: snap1.inferences.length, seq: snap1.statementHistorySeq }));

  // AUD-03：推断与判定版本正确对应（快照字段来自库中条目）
  const matchEntry = snap1.inferences.every((row) => {
    const base = entry.find((e) => e.id === row.id);
    return base && row.contentVersion === base.contentVersion && row.templateVersion === base.templateVersion
      && row.evidenceHash === base.evidenceHash && row.source === base.source && row.quote === (base.quote || null);
  });
  const verdictMatch = snap1.verdicts.every((v) => {
    const base = entry.find((e) => e.id === v.id);
    const stored = verdicts[v.id];
    return base && v.contentVersion === base.contentVersion && v.evidenceHash === base.evidenceHash
      && v.verdict === "confirmed" && v.judgmentState === "valid" && stored.contentVersion === v.contentVersion;
  });
  check("AUD-03", "AUD-03 快照中的推断版本/证据哈希/原话与判定版本，逐条对应库中条目", matchEntry && verdictMatch,
    JSON.stringify({ matchEntry, verdictMatch }));
  db1.close();

  // AUD-02：二次提交保留旧版本（旧快照逐字节不变）
  const db2 = makeDb();
  await SUB(db2, audBody({}), "AUD-K2a");
  const firstPayload = db2.get("SELECT payload FROM events WHERE type='employee_submitted' ORDER BY created_at ASC, id ASC LIMIT 1").payload;
  db2.exec(`UPDATE work_items SET stage='mapping', status='needs_input', assignee_role='employee', assignee_account_id='${EMP}' WHERE id='${ITEM}'`);
  // IMPLEMENT-05A：提交文本必须与服务端答案派生文本一致（改由规范文本派生；用不同的幂等键表示第二次提交）。
  const r2 = await SUB(db2, audBody({ text: canonicalText(AUD_ANSWERS) }), "AUD-K2b");
  const ev2 = eventsOf(db2);
  const firstAfter = db2.get("SELECT payload FROM events WHERE type='employee_submitted' ORDER BY created_at ASC, id ASC LIMIT 1").payload;
  check("AUD-02", "AUD-02 二次提交后，版本 1 的完整快照仍可独立读取且未被覆盖",
    r2.status === 200 && ev2.length === 2 && ev2[0].submissionVersion === 1 && ev2[1].submissionVersion === 2
      && firstAfter === firstPayload && ev2[0].inferences.length === ev2[1].inferences.length,
    JSON.stringify({ versions: ev2.map((e) => e.submissionVersion), unchanged: firstAfter === firstPayload }));
  db2.close();

  // AUD-04：客户端伪造快照字段被忽略（快照只取服务端基线）
  const db4 = makeDb();
  const forged = { inferences: [{ id: "INF-FAKE", text: "伪造推断", contentVersion: 999 }], verdicts: [{ id: "INF-FAKE", verdict: "confirmed", contentVersion: 999 }], submissionVersion: 99, statementHistorySeq: 9999 };
  await SUB(db4, audBody(forged), "AUD-K4");
  const snap4 = eventsOf(db4)[0];
  check("AUD-04", "AUD-04 客户端伪造 inferences/verdicts/submissionVersion/statementHistorySeq → 快照仍取服务端状态",
    snap4.submissionVersion === 1 && snap4.statementHistorySeq === Math.max(...hist.map((e) => e.seq))
      && !snap4.inferences.some((row) => row.id === "INF-FAKE") && !snap4.verdicts.some((row) => row.id === "INF-FAKE")
      && snap4.inferences.every((row) => entry.some((e) => e.id === row.id)),
    JSON.stringify({ v: snap4.submissionVersion, seq: snap4.statementHistorySeq, ids: snap4.inferences.map((r) => r.id) }));
  db4.close();

  // AUD-05：幂等重复提交不重复记账
  const db5 = makeDb();
  const i1 = await SUB(db5, audBody({}), "AUD-SAME");
  const i2 = await SUB(db5, audBody({}), "AUD-SAME");
  const ev5 = eventsOf(db5);
  const idemN = db5.get("SELECT COUNT(*) AS n FROM idempotency_records").n;
  // 第二次请求被"任务已转交核验人"的角色守卫拒绝（403）—— 比起幂等重放更严格
  check("AUD-05", "AUD-05 同一幂等键重复请求：不新增提交事件、不重复记账（重复请求被拒）",
    i1.status === 200 && i2.status !== 200 && ev5.length === 1 && Number(idemN) === 1,
    JSON.stringify({ first: i1.status, second: i2.status, events: ev5.length, idempotency: Number(idemN) }));
  db5.close();

  // AUD-06：并发提交版本不串号（CAS：第二次基于过期 revision 必须失败）
  const db6 = makeDb();
  const c1 = await SUB(db6, audBody({}), "AUD-C1");
  const c2 = await SUB(db6, audBody({ text: canonicalText(AUD_ANSWERS) }), "AUD-C2");   // 状态已变 ⇒ CAS 影响 0 行
  const ev6 = eventsOf(db6);
  const item6 = db6.get("SELECT submission_version FROM work_items WHERE id=?", ITEM);
  check("AUD-06", "AUD-06 并发/过期提交：只产生一次有效提交，快照与 submissionVersion 不串号",
    c1.status === 200 && c2.status !== 200 && ev6.length === 1
      && Number(item6.submission_version) === 1 && ev6[0].submissionVersion === 1,
    JSON.stringify({ first: c1.status, second: c2.status, events: ev6.length, dbVersion: Number(item6.submission_version) }));
  db6.close();

  // AUD-07：提交失败不产生任何审计快照
  const db7 = fixture({ answers: AUD_ANSWERS, inferences: entry, verdicts: {}, revision: 10, statementHistory: hist });  // 未判定 → 门禁拒绝
  const f1 = await SUB(db7, audBody({}), "AUD-FAIL");
  const ev7 = eventsOf(db7);
  const item7 = db7.get("SELECT stage, status, submission_version FROM work_items WHERE id=?", ITEM);
  check("AUD-07", "AUD-07 提交被门禁拒绝时：不产生 employee_submitted 事件、状态与版本不变",
    f1.status === 422 && ev7.length === 0 && item7.stage === "mapping" && Number(item7.submission_version) === 0,
    JSON.stringify({ status: f1.status, events: ev7.length, db: { stage: item7.stage, v: Number(item7.submission_version) } }));
  db7.close();

  // AUD-08：原有核验接口行为不变（alternativeExplanations 仍表示"当前快照"）
  const db8 = makeDb();
  await SUB(db8, audBody({}), "AUD-V8");
  db8.exec(`INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-AUD8','${VER}','${P}','2099-01-01T00:00:00Z','R8');
            INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,status,evidence_level,created_at) VALUES ('CF-AUD8','${P}','${ITEM}','workflow','陈述事实','workflowCard','open','E3',datetime('now'))`);
  const vres = await readVerifierFacts({ request: bearerRequest(`http://127.0.0.1/api/formal/projects/${P}/verifier-facts`, "TOK-AUD8"), env: { DB: db8 }, params: { projectId: P } });
  const vbody = await vres.clone().json().catch(() => ({}));
  const vjson = JSON.stringify(vbody);
  const factsRow = (vbody.facts || [])[0] || null;
  const alt = factsRow && factsRow.alternativeExplanations ? factsRow.alternativeExplanations : [];
  check("AUD-08", "AUD-08 核验接口语义不变：alternativeExplanations 仍为当前快照，且不加入事件审计字段",
    vres.status === 200 && Array.isArray(alt) && alt.length === entry.length
      && !/statementHistorySeq|submissionSchemaVersion/.test(vjson)
      && alt.every((row) => row && row.id && Number.isInteger(row.contentVersion)),
    JSON.stringify({ status: vres.status, alt: alt.length, hasAuditFields: /statementHistorySeq|submissionSchemaVersion/.test(vjson) }));
  db8.close();

  // AUD-09：原有推断判定门禁不变
  const db9 = fixture({ answers: AUD_ANSWERS, inferences: entry, verdicts: { [entry[0].id]: stamp(entry[0], "confirmed") }, revision: 10, statementHistory: hist });
  const g1 = await SUB(db9, audBody({}), "AUD-GATE");
  check("AUD-09", "AUD-09 原有判定门禁不变：仍有未判定/过期判定 → 422 inferences_unjudged，无快照",
    g1.status === 422 && eventsOf(db9).length === 0, `status=${g1.status}`);
  db9.close();

  // AUD-10：历史陈述边界可追溯（seq 上界与库中历史一致）
  const db10 = makeDb();
  await SUB(db10, audBody({}), "AUD-K10");
  const draftHist = (normalizeEmployeeDraft(JSON.parse(db10.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json)).ledger?.statementHistory) || [];
  const snap10 = eventsOf(db10)[0];
  check("AUD-10", "AUD-10 快照记录的历史边界与库中 statementHistory 上界/条数一致",
    snap10.statementHistorySeq === Math.max(...draftHist.map((e) => e.seq))
      && snap10.statementHistoryCount === draftHist.length && snap10.statementHistorySeq === 7,
    JSON.stringify({ snapshot: [snap10.statementHistorySeq, snap10.statementHistoryCount], db: [Math.max(...draftHist.map((e) => e.seq)), draftHist.length] }));
  db10.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n──────────────── 汇总 ────────────────");
const failed = results.filter((r) => r.verdict === "FAIL");
for (const r of results) {
  console.log(`  ${r.verdict === "PASS" ? "✔" : "✘"} [${r.verdict}] ${r.id} · ${r.name}${r.note ? `\n        ${r.note}` : ""}`);
}
console.log(`\n  PASS=${results.length - failed.length}  FAIL=${failed.length}`);
console.log("\n  【本地模拟 + 内存库】不构成真实模型或浏览器端到端验证。\n");
assert.equal(failed.length, 0, "存在失败用例");
console.log("  pilot09c runtime: ok");
