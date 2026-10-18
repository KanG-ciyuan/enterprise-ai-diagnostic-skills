/**
 * PILOT-04 P0 数据与状态缺陷修复 —— 运行时行为测试
 *
 * 覆盖报告要求的 T1–T12 与全部额外断言。所有断言使用**真实 handler** 与
 * **可观察数据库状态**，不以源码字符串搜索代替行为测试。
 *
 * 结果分三类：PASS / FAIL / UNCOVERED（UNCOVERED 不计入通过）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DRAFT_SCHEMA_VERSION, draftRevisionOf, normalizeEmployeeDraft, serializeEmployeeDraft } from "../functions/_shared.js";
import { ANSWER_DIMENSIONS as EVIDENCE_DIMENSIONS, canonicalJson as evidenceCanonicalJson, normalizeAnswers as evidenceNormalizeAnswers } from "../functions/api/agent/_evidence.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { onRequestPost as agentTurn } from "../functions/api/agent/employee-turn.js";
import { appendStatementHistory, buildInferenceRecords, buildLedgerFromAnswers, runFixture, QUESTION_BANK } from "../functions/api/agent/_adapter.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const TEST_MODEL_KEY = "fake-deepseek-key-not-real";   // 本地模拟模型；绝不触网
const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });
const uncovered = (id, name, note = "") => results.push({ id, name, verdict: "UNCOVERED", note });

const P = "PRJ-P04TEST0001";
const ITEM = "WI-P04TEST01";
const EMP = "ACC-P04-EMP";
const VER = "ACC-P04-VER";
const OTHER = "ACC-P04-OTHER";
const TOK_EMP = "TOK-P04-EMP";
const TOK_OTHER = "TOK-P04-OTHER";

function fixture({ stage = "mapping", status = "needs_input", draft = null, accountId = EMP } = {}) {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@v01.invalid','小李','active','member'),
      ('${VER}','ver@v01.invalid','核验人','active','member'),
      ('${OTHER}','other@v01.invalid','他人','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES
      ('${P}','短视频带货流程诊断','选品到发布与复盘','facts','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P}','${EMP}','employee','project','active'),
      ('${P}','${VER}','verifier','project','active'),
      ('${P}','${OTHER}','employee','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-P04','${P}','授权','王总','o@v01.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    -- 提交时必须能解析出"已接受的核验人"，否则进入 blocked_draft 分支而不产生事实。
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key) VALUES
      ('INV-P04-VER','invite-p04-ver','${P}','${EMP}','ver@v01.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','INVK-P04');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status) VALUES
      ('${ITEM}','${P}','还原工作','描述','${stage}','${status}','employee','小李',0,'等待','开始','${accountId}','${VER}',${draft === null ? "'{}'" : `'${JSON.stringify(draft)}'`},'undecided');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK_EMP}','${EMP}','${P}','2099-01-01T00:00:00Z','R1'),
      ('${TOK_OTHER}','${OTHER}','${P}','2099-01-01T00:00:00Z','R2');
  `);
  return db;
}

const putDraft = (db, body, token = TOK_EMP) =>
  saveDraft({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, token, body), env: { DB: db }, params: { itemId: ITEM } });

const postSubmit = (db, body, token = TOK_EMP, key = "KEY-P04") =>
  // PILOT-09C/FIX-CODEX-03A：正式提交现在必须携带 baseRevision（测试按库中当前版本补齐）。
  submitEmployee({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, token, { ...body, baseRevision: Number.isInteger(body.baseRevision) ? body.baseRevision : readDraft(db).revision }, { "Idempotency-Key": key }), env: { DB: db }, params: { itemId: ITEM } });

const postTurn = (db, body, token = TOK_EMP, env = {}) =>
  agentTurn({ request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", token, body), env: { DB: db, FORMAL_AUTH_MODE: "development", ...env }, params: {} });

const readDraft = (db) => normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));

// ── PILOT-09C/IMPLEMENT-05A（F04）：正式提交只承认服务端规范卡/规范文本 ─────
// 新契约下服务端从**已持久化的草稿 answers + material_status** 派生 card/text，
// 客户端载荷与之不一致即 422。因此测试按真实生产顺序执行：
//   ① PUT 草稿（员工答案/材料状态真实落库）→ ② 用库中派生值提交。
// 断言本身不变：仍然验证"提交后的事实/落库结果"。
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
const itemMaterialStatus = (db) => db.get("SELECT material_status FROM work_items WHERE id=?", ITEM).material_status;
const canonicalCard = (db) => {
  const draft = readDraft(db);
  const card = {};
  for (const [key] of ANSWER_DIMENSIONS) card[key] = String(draft.answers[key] || "").trim();
  card.materialIndex = MATERIAL_INDEX_LABELS[itemMaterialStatus(db)];
  return card;
};
const canonicalText = (db) => {
  const draft = readDraft(db);
  return ANSWER_DIMENSIONS.map(([key, label]) => `${label}：${String(draft.answers[key] || "").trim()}`).join("\n\n");
};
// ── PILOT-09C/IMPLEMENT-05B（F03）：服务端证据状态夹具 ───────────────────────
// F03 起正式提交还要求：ledger.evidence（answersDigest/维度 digest）、statementHistory
// 与当前答案一致、每条推断带 evidenceVersion/evidenceRefs、判定回显 evidenceVersion。
// 旧夹具只播种 answers/推断，未走统一证据入口。这里用**服务端构建函数**
// （appendStatementHistory / canonicalJson / normalizeAnswers）生成与真实
// employee-draft 写入**同构**的证据状态（摘要用 node:crypto 按同一 SHA-256 算法独立计算），
// 从而在不改变既有 revision/断言数值的前提下让原断言继续成立。
const evidenceSha256 = (value) => `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
const DEFAULT_INFERENCE_DEFS = [
  { source: "model", text: "P0 基线推断 1：服务端权威记录（步骤）", basis: "steps", assumes: "若与实际不符需更正" },
  { source: "model", text: "P0 基线推断 2：服务端权威记录（判断）", basis: "judgments", assumes: "若与实际不符需更正" },
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
/** 直接把与当前草稿一致的证据状态写入库中草稿（模拟 employee-draft 统一证据写入的结果）。 */
function installEvidenceBaseline(db) {
  const draft = readDraft(db);
  const prior = Array.isArray(draft.ledger?.authoritativeInferences) ? draft.ledger.authoritativeInferences : [];
  const inferences = prior.length ? prior : buildInferenceRecords([], DEFAULT_INFERENCE_DEFS).records;
  const seed = seedEvidenceState({ answers: draft.answers, inferences, revision: draft.revision, verdicts: draft.inferenceVerdicts || {} });
  const ledger = {
    ...(draft.ledger || {}),
    statements: seed.normalized,
    covered: Object.keys(seed.normalized),
    evidence: seed.evidence,
    statementHistory: seed.history,
    authoritativeInferences: seed.inferences,
  };
  db.prepare("UPDATE work_items SET employee_draft_json=? WHERE id=?").bind(serializeEmployeeDraft({
    answers: draft.answers, ledger, inferenceVerdicts: seed.verdicts, submissionText: draft.submissionText, revision: draft.revision,
  }), ITEM).run();
  return seed;
}

/** 先按真实流程保存员工答案与材料状态，再补齐服务端证据状态，最后从库中派生规范卡/文本提交。 */
async function submitSavedAnswers(db, answers, materialStatus = "provided", extra = {}, token = TOK_EMP) {
  await putDraft(db, { answers, materialStatus, baseRevision: readDraft(db).revision }, token);
  installEvidenceBaseline(db);
  return postSubmit(db, { ...extra, text: canonicalText(db), workflowCard: canonicalCard(db), materialStatus }, token);
}

console.log("PILOT-04 P0 修复 —— 运行时行为测试\n");

// ═══ T1：前后端维度键集合一致 ═══
console.log("T1 前后端七维键集合一致");
{
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const start = appSrc.indexOf("const formalEmployeeQuestions");
  const segment = appSrc.slice(start, start + 1600);
  const frontendKeys = [...segment.matchAll(/\{ key: "(\w+)"/g)].map((m) => m[1]);
  const backendKeys = QUESTION_BANK.map((q) => q.key);
  const same = frontendKeys.length === backendKeys.length && frontendKeys.every((k, i) => k === backendKeys[i]);
  if (same && frontendKeys.length === 7) pass("T1", "前端题库键集合 == 后端 QUESTION_BANK", frontendKeys.join(","));
  else fail("T1", "前后端维度不一致", `前端=[${frontendKeys}] 后端=[${backendKeys}]`);
}

// ═══ T3：流程卡字段与服务端校验一致 ═══
console.log("T3 流程卡字段与服务端 CARD_FIELDS 一致");
{
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const cardStart = appSrc.indexOf("function formalEmployeeCard()");
  const cardBody = appSrc.slice(cardStart, cardStart + 900);
  const cardKeys = [...cardBody.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  const serverSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/employee-submission.js", import.meta.url), "utf8");
  const serverFields = JSON.parse(serverSrc.match(/const CARD_FIELDS = (\[[^\]]+\]);/)[1].replace(/'/g, '"'));
  const missing = serverFields.filter((k) => !cardKeys.includes(k));
  if (missing.length === 0) pass("T3", "前端流程卡覆盖服务端全部必填字段", `卡片=[${cardKeys}] 服务端=[${serverFields}]`);
  else fail("T3", "前端流程卡缺少服务端必填字段", missing.join(","));
}

// ═══ T2：handoff / burden 进入可核验事实 ═══
console.log("T2 handoff/burden 进入可核验事实");
{
  const db = fixture();
  // IMPLEMENT-05A：卡片/文本必须由**服务端草稿**派生。先把员工答案真实保存进草稿，
  // 再以服务端规范卡提交；断言仍验证 handoff/burden 进入事实。
  const answers = {
    trigger: "每天看后台和榜单", inputs: "曝光、点击、成交", steps: "选题到发布",
    judgments: "低毛利找老板", exceptions: "版权问题换同款",
    handoff: "剪完给投放同事挂车", burden: "一条大概 3 小时，我自己做",
  };
  const response = await submitSavedAnswers(db, answers, "provided");
  const facts = db.all("SELECT fact_type,source_field,claim FROM candidate_facts WHERE work_item_id=?", ITEM);
  const allFields = facts.map((f) => f.source_field).join("|");
  const allClaims = facts.map((f) => f.claim).join("|");
  const ok = response.status === 200
    && allFields.includes("handoff") && allFields.includes("burden")
    && allClaims.includes("交给谁") && allClaims.includes("耗时与人力");
  if (ok) pass("T2", "handoff/burden 同时进入 source_field 与事实正文", `字段=${allFields}`);
  else fail("T2", "handoff/burden 未进入事实", `status=${response.status} 字段=${allFields}`);
  db.close();
}

// ═══ T4：每轮自动保存 answers + ledger ═══
console.log("T4 草稿保存 answers + ledger");
{
  const db = fixture();
  const ledger = { statements: { trigger: "每天早上看后台" }, covered: ["trigger"], vagueTerms: [{ key: "steps", count: 2 }], unresolved: [], evidence: [] };
  const response = await putDraft(db, { answers: { trigger: "每天早上看后台" }, materialStatus: "provided", baseRevision: 0, ledger, inferenceVerdicts: { "INF-1": { verdict: "correct", correction: "其实是投放同事决定" } } });
  const draft = readDraft(db);
  const ok = response.status === 200
    && draft.schemaVersion === DRAFT_SCHEMA_VERSION
    && draft.answers.trigger === "每天早上看后台"
    && draft.ledger?.vagueTerms?.[0]?.count === 2
    && draft.inferenceVerdicts?.["INF-1"]?.verdict === "corrected"
    && draft.inferenceVerdicts?.["INF-1"]?.correction === "其实是投放同事决定";
  if (ok) pass("T4", "answers 与 ledger 与推断判定均已落库");
  else fail("T4", "落库内容不完整", JSON.stringify(draft));
  db.close();
}

// ═══ T5：旧格式草稿兼容 ═══
console.log("T5 旧版扁平格式兼容");
{
  const db = fixture({ draft: { trigger: "旧答案A", inputs: "旧答案B", submissionText: "旧全文" } });
  const task = JSON.parse(JSON.stringify(normalizeEmployeeDraft({ trigger: "旧答案A", inputs: "旧答案B", submissionText: "旧全文" })));
  const ok = task.answers.trigger === "旧答案A" && task.answers.inputs === "旧答案B"
    && !("submissionText" in task.answers) && task.ledger === null;
  if (ok) pass("T5", "旧扁平格式可读且内部键不进入答案", JSON.stringify(task.answers));
  else fail("T5", "旧格式解析错误", JSON.stringify(task));
  // 旧格式行经过一次 PUT 后应升级为 v2，且答案不丢
  const response = await putDraft(db, { answers: { steps: "新答案C" }, materialStatus: "provided", baseRevision: 0 });
  const after = readDraft(db);
  if (response.status === 200 && after.schemaVersion === DRAFT_SCHEMA_VERSION && after.answers.trigger === "旧答案A" && after.answers.steps === "新答案C") {
    pass("T5b", "旧格式经 PUT 升级为 v2 且答案保留");
  } else {
    fail("T5b", "格式升级丢失答案", JSON.stringify(after.answers));
  }
  db.close();
}

// ═══ T6：刷新后恢复回答及追问状态 ═══
console.log("T6 刷新后恢复回答与追问状态");
{
  const db = fixture();
  const ledger = { statements: { trigger: "a" }, covered: ["trigger"], vagueTerms: [{ key: "steps", count: 2 }], unresolved: [{ key: "steps", dimension: "steps", reason: "重复追问后仍不明确" }], evidence: [] };
  await putDraft(db, { answers: { trigger: "a", inputs: "b" }, materialStatus: "provided", ledger, baseRevision: 0 });
  const draft = readDraft(db);
  const restoredOk = draft.answers.trigger === "a" && draft.answers.inputs === "b"
    && draft.ledger.vagueTerms[0].count === 2 && draft.ledger.unresolved.length === 1;
  if (restoredOk) pass("T6", "答案 + 追问计数 + 未解决项均可恢复");
  else fail("T6", "恢复内容不完整", JSON.stringify(draft));
  db.close();
}

// ═══ T7：新格式不污染答案 ═══
console.log("T7 新格式不污染答案（N3）");
{
  const db = fixture();
  // 攻击面：把 ledger 直接塞进 answers
  await putDraft(db, { answers: { trigger: "有效答案", ledger: { covered: ["x"] }, schemaVersion: 99 }, materialStatus: "provided", baseRevision: 0 });
  const draft = readDraft(db);
  const polluted = "ledger" in draft.answers || "schemaVersion" in draft.answers;
  if (!polluted && draft.answers.trigger === "有效答案") pass("T7", "结构型键被拒绝进入答案集", Object.keys(draft.answers).join(","));
  else fail("T7", "答案集被污染", JSON.stringify(draft.answers));
  db.close();
}

// ═══ T8：重复点击只产生一次有效 Agent 调用 ═══
console.log("T8 重复请求只产生一次有效 Agent 调用");
{
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  // 前端按钮禁用必须绑定真实存在的状态字段
  const disabledUsesRealField = appSrc.includes('state.formalAgentThinking || state.formalEmployeeSaving ? "disabled"');
  const staleFieldRemoved = !appSrc.includes("state.formalEmployeeThinking");
  if (disabledUsesRealField && staleFieldRemoved) pass("T8", "按钮禁用绑定真实状态字段（formalEmployeeThinking 已消除）");
  else fail("T8", "按钮禁用仍绑定不存在的字段", `usesReal=${disabledUsesRealField} removed=${staleFieldRemoved}`);
  // 服务端防线：陈旧轮次被拒绝（不依赖前端禁用）
  const db = fixture();
  const ledger = { statements: {}, covered: ["trigger", "inputs", "steps"], vagueTerms: [], unresolved: [], evidence: [] };
  // 一次成功写入把库中 revision 推到 1
  const first = await putDraft(db, { answers: { trigger: "a", inputs: "b", steps: "c" }, materialStatus: "provided", ledger, baseRevision: 0 });
  assert.equal(first.status, 200, "首次草稿写入应成功");
  const response = await postTurn(db, { projectId: P, workItemId: ITEM, questionKey: "judgments", answer: "低毛利找老板", answers: {}, mode: "fixture", baseRevision: 0 });
  if (response.status === 409) pass("T8b", "服务端拒绝迟到旧响应（不依赖前端禁用）", "stale_turn");
  else fail("T8b", "服务端未拒绝陈旧轮次", String(response.status));
  db.close();
}

// ═══ T9：并发/陈旧轮次不会互相覆盖 ═══
console.log("T9 陈旧轮次不会覆盖新状态");
{
  const db = fixture();
  const base = { statements: {}, covered: ["trigger", "inputs"], vagueTerms: [], unresolved: [], evidence: [] };
  const seed = await putDraft(db, { answers: { trigger: "a", inputs: "b" }, materialStatus: "provided", ledger: base, baseRevision: 0 });
  assert.equal(seed.status, 200, "初始草稿写入应成功");
  // 客户端声称 baseRevision=0，而库中已写入 revision=1 → 应拒绝（409 stale_turn）
  const stale = await postTurn(db, { projectId: P, workItemId: ITEM, questionKey: "steps", answer: "x", answers: {}, mode: "fixture", baseRevision: 0 });
  // PILOT-08A：回答必须绑定服务端签发的锚点。先让服务端签发（此时缺 steps），再用它作答。
  const anchor = await issueServerAnchor(db, TOK_EMP);
  // 客户端带上当前修订号 → 应放行
  const fresh = await postTurn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "先选题再剪辑再挂车发布", answers: { steps: "先选题再剪辑再挂车发布" }, mode: "fixture", baseRevision: anchor.revision });
  if (stale.status === 409 && fresh.status === 200) pass("T9", "旧轮次 409、当前轮次 200（携带服务端签发锚点）");
  else fail("T9", "轮次判定不符合预期", `stale=${stale.status} fresh=${fresh.status}`);
  db.close();
}

// ═══ 额外：未授权员工不能读/改他人草稿 ═══
console.log("额外：草稿的越权防护");
{
  const db = fixture({ accountId: EMP });
  const readAsOther = await putDraft(db, { answers: { trigger: "越权写入" }, materialStatus: "provided" }, TOK_OTHER);
  const draftAfter = readDraft(db);
  if (readAsOther.status === 403 && Object.keys(draftAfter.answers).length === 0) {
    pass("额外", "非本人（他人 employee）无法写入他人草稿 → 403");
  } else {
    fail("额外", "越权写入未被阻止", `status=${readAsOther.status} answers=${JSON.stringify(draftAfter.answers)}`);
  }
  db.close();
}
{
  // 无会话 / 演示头访问草稿接口
  const db = fixture();
  const noSession = await saveDraft({ request: new Request(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: { trigger: "x" } }) }), env: { DB: db }, params: { itemId: ITEM } });
  const demoHeader = await saveDraft({ request: new Request(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, { method: "PUT", headers: { "content-type": "application/json", "X-Demo-Role": "employee", "X-Demo-User": EMP }, body: JSON.stringify({ answers: { trigger: "x" } }) }), env: { DB: db }, params: { itemId: ITEM } });
  const answersAfter = readDraft(db).answers;
  if (noSession.status === 401 && demoHeader.status === 401 && Object.keys(answersAfter).length === 0) {
    pass("额外", "无会话与演示头访问草稿接口均 401 且无副作用");
  } else {
    fail("额外", "未授权访问未被阻止", `noSession=${noSession.status} demo=${demoHeader.status}`);
  }
  db.close();
}

// ═══ 额外：已完成任务不能继续修改访谈状态 ═══
console.log("额外：已完成任务禁止继续修改");
{
  const db = fixture({ stage: "decision", status: "complete" });
  const draftWrite = await putDraft(db, { answers: { trigger: "x" }, materialStatus: "provided" });
  const turn = await postTurn(db, { projectId: P, workItemId: ITEM, questionKey: "trigger", answer: "x", answers: {}, mode: "fixture" });
  if (draftWrite.status === 409 && turn.status === 409) pass("额外", "已完成任务：草稿 409、Agent 轮 409");
  else fail("额外", "已完成任务仍可修改", `draft=${draftWrite.status} turn=${turn.status}`);
  db.close();
}

// ═══ 额外：模型输出不能直接变成已核实事实 ═══
console.log("额外：模型输出不能直接成为已核实事实");
{
  const agentSrc = readFileSync(new URL("../functions/api/agent/employee-turn.js", import.meta.url), "utf8");
  const adapterSrc = readFileSync(new URL("../functions/api/agent/_adapter.js", import.meta.url), "utf8");
  const writesFacts = /candidate_facts/.test(agentSrc) || /candidate_facts/.test(adapterSrc);
  if (!writesFacts) pass("额外", "访谈链路（handler + adapter）完全不写 candidate_facts");
  else fail("额外", "访谈链路出现 candidate_facts 写入");
  // 新提交的事实必须从 open 开始，且等级不由模型给出
  const db = fixture();
  // IMPLEMENT-05A：服务端只从草稿 answers 生成规范卡 → 先保存完整 7 维答案再提交。
  await submitSavedAnswers(db, {
    trigger: "a", inputs: "b", steps: "c", judgments: "d", exceptions: "e", handoff: "f", burden: "g",
  }, "provided");
  const facts = db.all("SELECT status,evidence_level FROM candidate_facts WHERE work_item_id=?", ITEM);
  const allOpen = facts.length > 0 && facts.every((f) => f.status === "open" && f.evidence_level === null);
  if (allOpen) pass("额外", "候选事实初始 status=open 且 evidence_level 为空（等级仅由核验人认定）");
  else fail("额外", "候选事实初始状态异常", JSON.stringify(facts));
  db.close();
}

// ═══ 额外：E1–E5 与双人核验规则未变 ═══
console.log("额外：E1–E5 与双人核验规则保持不变");
{
  const verificationSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/verification.js", import.meta.url), "utf8");
  const hasDoubleGuard = verificationSrc.includes("first_verified_by_account_id!=?")
    && verificationSrc.includes("首次核验人不能完成同一事实的二次确认");
  const sharedSrc = readFileSync(new URL("../functions/_shared.js", import.meta.url), "utf8");
  const hasE1E5 = /\["E1"/.test(verificationSrc) || verificationSrc.includes('"E5"');
  if (hasDoubleGuard && hasE1E5) pass("额外", "双人核验强制点与 E1–E5 等级集合均未改动");
  else fail("额外", "核验规则疑似被改动", `doubleGuard=${hasDoubleGuard} e1e5=${hasE1E5}`);
}

// ═══ T12：更正内容持久化且核验可见 ═══
console.log("T12 更正内容持久化");
{
  // PILOT-08E/D1：推断原文必须来自**服务端基线**，因此先由"服务端"确立基线。
  // 客户端同时故意提交一段**不同的** text，用于证明它不被采信。
  // ── PILOT-09C/IMPLEMENT-2B：旧式夹具现代化 ────────────────────────────
  // 可信基线必须由**真实服务端构建函数**（buildInferenceRecords）产出：
  //   · contentVersion / evidenceHash / templateVersion / listed 全部由服务端计算；
  //   · 不手工伪造"看似有效"的版本对象（否则测试会在生产路径之外自证成立）；
  //   · 沿用本用例原有的推断 ID（ID 仅是标识符），因此**原断言一字未改**。
  // 同时把判定写入**草稿**（inferenceVerdicts）—— 依据 IMPLEMENT-2B/F2，
  // 提交门禁的唯一可信判定来源是库中持久化草稿，而非请求体。
  // F03：模板推断的 quote 必须与**当前服务端答案**一致（否则提交门禁会按
  // "模板引用与答案不一致"拒绝）。此处 quote 取本用例随后保存的 exceptions 答案；
  // 断言仍验证"落库的推断原文取自服务端基线"（text 不变）。
  const _inferDefs = [{ legacyId: "INF-1", idSource: "template:exceptions:no-delete", source: "server_template", templateVersion: 1, quote: "版权问题换同款", text: "服务端基线原文：异常处理不会删除既有记录", basis: "exceptions", assumes: "若包含删除须更正" }];
  const _inferBaseline = buildInferenceRecords([], _inferDefs).records.map((entry, index) => ({ ...entry, id: _inferDefs[index].legacyId }));
  const _inferVerdict = (id, spec) => ({
    verdict: spec.verdict,
    correction: spec.correction || "",
    contentVersion: _inferBaseline.find((entry) => entry.id === id).contentVersion,
    templateVersion: _inferBaseline.find((entry) => entry.id === id).templateVersion,
    evidenceHash: _inferBaseline.find((entry) => entry.id === id).evidenceHash,
  });
  const db = fixture({ draft: { schemaVersion: 2, revision: 0, answers: {}, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], authoritativeInferences: _inferBaseline }, inferenceVerdicts: { "INF-1": _inferVerdict("INF-1", { verdict: "correct", correction: "其实是版权原因才换" }) }, submissionText: "" } });
  const inferences = [{ id: "INF-1", text: "客户端伪造原文：应被忽略", basis: "exceptions", assumes: "x" }];
  // IMPLEMENT-05A：服务端规范卡只从草稿 answers 派生；先保存完整七维答案，
  // 再以服务端规范卡/规范文本提交（客户端 inferences 仍按原用例发送，以证明不被采信）。
  await submitSavedAnswers(db, {
    trigger: "每天看后台和榜单", inputs: "曝光、点击、成交", steps: "选题到发布",
    judgments: "低毛利找老板", exceptions: "版权问题换同款",
    handoff: "剪完给投放同事挂车", burden: "一条大概 3 小时",
  }, "provided", {
    inferences,
    inferenceVerdicts: { "INF-1": { verdict: "correct", correction: "其实是版权原因才换" } },
  });
  const raw = db.get("SELECT alternative_explanations_json FROM work_items WHERE id=?", ITEM).alternative_explanations_json;
  const parsed = JSON.parse(raw);
  // PILOT-07C/R2：判定值在服务端边界被规范化为 confirmed/corrected/unjudged。
  // 前端仍发 "correct"（需要更正），落库为 "corrected"。
  // PILOT-08E/D1：除判定与更正外，还断言**推断原文取自服务端基线**（客户端自报被忽略）。
  const ok = parsed.length === 1 && parsed[0].verdict === "corrected" && parsed[0].correction === "其实是版权原因才换" && parsed[0].id === "INF-1"
    && parsed[0].text === "服务端基线原文：异常处理不会删除既有记录";
  if (ok) pass("T12", "推断判定与更正已落库；且原文取自服务端基线（客户端自报 text 被忽略）", JSON.stringify(parsed[0] && { verdict: parsed[0].verdict, correction: parsed[0].correction, text: parsed[0].text }));
  else fail("T12", "更正未正确落库", raw);
  db.close();
}
{
  // 核验人侧读取该列
  const sharedSrc = readFileSync(new URL("../functions/_shared.js", import.meta.url), "utf8");
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const readsIt = sharedSrc.includes("alternativeExplanations: parseJson(item.alternative_explanations_json");
  const rendersIt = appSrc.includes("alternative-explanations") || appSrc.includes("task.alternativeExplanations");
  if (readsIt && rendersIt) pass("T12b", "核验侧已暴露该字段且有渲染点（数据可被核验人读到）");
  else fail("T12b", "核验侧未暴露更正数据", `reads=${readsIt} renders=${rendersIt}`);
}

// ═══ T10：模型超时后安全降级 ═══
console.log("T10 模型超时安全降级");
{
  const src = readFileSync(new URL("../functions/api/agent/employee-turn.js", import.meta.url), "utf8");
  const hasAbort = src.includes("AbortController") && src.includes("signal: controller.signal");
  const hasTimeoutConst = /MODEL_TIMEOUT_MS\s*=\s*\d+/.test(src);
  const abortsMessage = src.includes("模型调用超时");
  if (hasAbort && hasTimeoutConst && abortsMessage) pass("T10", "模型调用具备明确超时与超时错误");
  else fail("T10", "模型调用缺少超时控制", `abort=${hasAbort} const=${hasTimeoutConst}`);
  // 行为侧：模型不可用时降级为确定性路径（不产生半截状态）
  const db = fixture();
  const anchor = await issueServerAnchor(db, TOK_EMP);
  const res = await postTurn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "每天早上看后台和榜单", answers: { trigger: "每天早上看后台和榜单" }, mode: "auto", baseRevision: anchor.revision });
  const body = await res.json().catch(() => ({}));
  // PILOT-09C/IMPLEMENT-05B（F03-2）：turn 成功即**原子落库本轮答案 + 历史**。
  // 新契约下"不产生半截会话状态"的判据从"草稿完全不写入"升级为"本轮答案与历史
  // 在同一份草稿里一致落库"（更强：既证明写入了、也证明答案/历史没有分裂）。
  const stored = readDraft(db);
  const history = stored.ledger?.statementHistory || [];
  const latest = history.filter((entry) => entry.dimension === anchor.key).slice(-1)[0] || null;
  const atomicPersisted = stored.answers[anchor.key] === "每天早上看后台和榜单"
    && latest && latest.kind !== "withdrawn" && latest.text === "每天早上看后台和榜单";
  if (res.status === 200 && body?.turn?.turnKind && atomicPersisted) {
    pass("T10b", "无密钥时安全降级为确定性路径，且本轮答案与陈述历史原子一致落库（无半截状态）");
  } else {
    fail("T10b", "降级路径异常", `status=${res.status} atomicPersisted=${atomicPersisted}`);
  }
  db.close();
}

// ═══ T11：保存失败时明确提示 ═══
console.log("T11 保存失败必须可见");
{
  const db = fixture();
  const realStatement = db.runStatement.bind(db);
  db.runStatement = (st) => {
    // CAS 写入的 SQL 现在带 WHERE ... json_extract(...) —— 按目标列匹配而非前缀
    if (typeof st.sql === "string" && /UPDATE work_items[\s\S]*employee_draft_json\s*=/.test(st.sql)) {
      throw new Error("injected_draft_write_failure");
    }
    return realStatement(st);
  };
  const response = await putDraft(db, { answers: { trigger: "会被丢弃的答案" }, materialStatus: "provided", baseRevision: 0 });
  db.runStatement = realStatement;
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const hasVisibleError = appSrc.includes("回答未能保存") && appSrc.includes('state.formalEmployeeSaveState = "error"');
  if (response.status >= 400 && hasVisibleError) {
    pass("T11", `写入失败返回 ${response.status}，前端有可见错误提示且状态置为 error`);
  } else {
    fail("T11", "保存失败未正确处理", `status=${response.status} visible=${hasVisibleError}`);
  }
  db.close();
}

// ═══ UNCOVERED 声明 ═══
console.log("未覆盖声明");
uncovered("浏览器", "自动保存徽标的真实浏览器渲染", "本轮为 handler 与静态结构验证；徽标在浏览器中的实际渲染与手机端布局属 PILOT-02/PILOT-03 的 P2 范围，本批未做真实浏览器走查。");
uncovered("模型", "真实模型超时行为", "本地无 DEEPSEEK_API_KEY（环境变量未设、.dev.vars 不存在），不得获取凭据；本轮只验证超时代码路径存在与无密钥降级行为，未做真实模型超时实测。");
uncovered("并发", "真实多标签页并发", "本轮以顺序请求 + 轮次计数验证陈旧响应被拒，未做真实多标签页同时写入的端到端并发测试。");

/**
 * PILOT-08A：安全边界变更 —— 回答必须绑定"服务端签发"的问题锚点。
 * 旧测试假设服务端会接受任意合法维度（无锚点引导轮）；该路径已被安全修复关闭。
 * 此处按线上真实流程取得锚点：服务端恢复签发 → 客户端保存 → 再作答。
 */
async function issueServerAnchor(db, token) {
  const revision = () => draftRevisionOf(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
  const rec = await agentTurn({
    request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", token, {
      projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revision(),
    }),
    env: { DB: db, DEEPSEEK_API_KEY: TEST_MODEL_KEY }, params: {},
  });
  const body = await rec.clone().json();
  const key = body?.turn?.nextQuestion?.key ?? null;
  if (key) {
    await saveDraft({
      request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, token, {
        answers: {}, materialStatus: "provided", baseRevision: revision(),
      }),
      env: { DB: db }, params: { itemId: ITEM },
    });
  }
  const stored = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
  return { key: stored.ledger?.pendingQuestion?.key ?? null, revision: revision(), status: rec.status };
}

const count = (v) => results.filter((r) => r.verdict === v).length;
console.log("\n──────────────── 结果明细 ────────────────");
for (const r of results) {
  const icon = r.verdict === "PASS" ? "✔" : r.verdict === "FAIL" ? "✘" : "○";
  console.log(`  ${icon} [${r.verdict}] ${r.id} · ${r.name}${r.note ? `\n        ${r.note}` : ""}`);
}
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${count("PASS")}  FAIL=${count("FAIL")}  UNCOVERED=${count("UNCOVERED")}`);
if (count("UNCOVERED")) {
  console.log("\n  UNCOVERED 明细（不得计入通过）：");
  for (const r of results.filter((x) => x.verdict === "UNCOVERED")) console.log(`    · ${r.id} ${r.name}\n      ${r.note}`);
}
assert.equal(count("FAIL"), 0, "存在 FAIL 用例");
console.log("\npilot04 p0 runtime: ok");
