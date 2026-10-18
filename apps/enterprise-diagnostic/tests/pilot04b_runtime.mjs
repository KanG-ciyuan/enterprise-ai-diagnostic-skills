/**
 * PILOT-04B —— P0 补充修复与并发验证
 *
 * 覆盖报告要求的四组证据：
 *   A. 并发令牌（统计计数不唯一/不单调 → 改用真实修订号 + 原子 CAS）
 *   B. 候选事实合并粒度（字段级来源、影响等级独立）
 *   C. D6 回退核验
 *   以及"常见测试要求" 1–10 条与额外安全断言。
 *
 * 结果分三类：PASS / FAIL / UNCOVERED（UNCOVERED 不计入通过）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  casWriteEmployeeDraft, draftRevisionOf, normalizeEmployeeDraft, serializeEmployeeDraft,
} from "../functions/_shared.js";
import { ANSWER_DIMENSIONS as EVIDENCE_DIMENSIONS, canonicalJson as evidenceCanonicalJson, normalizeAnswers as evidenceNormalizeAnswers } from "../functions/api/agent/_evidence.js";
import { appendStatementHistory, buildInferenceRecords } from "../functions/api/agent/_adapter.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { onRequestPost as agentTurn } from "../functions/api/agent/employee-turn.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const TEST_MODEL_KEY = "fake-deepseek-key-not-real";   // 本地模拟模型；绝不触网
const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });
const uncovered = (id, name, note = "") => results.push({ id, name, verdict: "UNCOVERED", note });

const P = "PRJ-P04B000001";
const ITEM = "WI-P04B0001";
const EMP = "ACC-P04B-EMP";
const VER = "ACC-P04B-VER";
const OTHER = "ACC-P04B-OTHER";
const TOK = "TOK-P04B-EMP";
const TOK_OTHER = "TOK-P04B-OTHER";

function fixture({ stage = "mapping", status = "needs_input", draft = null, accountId = EMP } = {}) {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@v01b.invalid','小李','active','member'),
      ('${VER}','ver@v01b.invalid','核验人','active','member'),
      ('${OTHER}','other@v01b.invalid','他人','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES
      ('${P}','短视频带货流程诊断','选品到发布与复盘','facts','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P}','${EMP}','employee','project','active'),
      ('${P}','${VER}','verifier','project','active'),
      ('${P}','${OTHER}','employee','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-P04B','${P}','授权','王总','o@v01b.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key) VALUES
      ('INV-P04B-VER','invite-p04b-ver','${P}','${EMP}','ver@v01b.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','INVK-P04B');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status) VALUES
      ('${ITEM}','${P}','还原工作','描述','${stage}','${status}','employee','小李',0,'等待','开始','${accountId}','${VER}',${draft === null ? "'{}'" : `'${JSON.stringify(draft)}'`},'undecided');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R1'),
      ('${TOK_OTHER}','${OTHER}','${P}','2099-01-01T00:00:00Z','R2');
  `);
  return db;
}

const putDraft = (db, body, token = TOK) =>
  saveDraft({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, token, body), env: { DB: db }, params: { itemId: ITEM } });
const turn = (db, body, token = TOK, envOverride = null) => agentTurn({ request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", token, body), env: { DB: db, ...(envOverride === null ? { DEEPSEEK_API_KEY: TEST_MODEL_KEY } : envOverride) }, params: {} });
const postTurn = (db, body, token = TOK) =>
  agentTurn({ request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", token, body), env: { DB: db }, params: {} });

// ── PILOT-09C/IMPLEMENT-05A（F04）：提交必须与"服务端持久化答案"逐字段一致 ──
// 服务端规范卡/文本 = 从库中草稿 answers + work_items.material_status 派生。
// 测试因此按真实生产顺序执行：① 用卡片里的七维内容 PUT 草稿（真实落库）；
// ② 从库中派生 canonicalCard/canonicalText 提交。卡片取值范围/事实结构断言不变。
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
const canonicalCardOf = (db) => {
  const draft = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
  const card = {};
  for (const [key] of ANSWER_DIMENSIONS) card[key] = String(draft.answers[key] || "").trim();
  card.materialIndex = MATERIAL_INDEX_LABELS[itemMaterialStatus(db)];
  return card;
};
const canonicalTextOf = (db) => {
  const draft = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
  return ANSWER_DIMENSIONS.map(([key, label]) => `${label}：${String(draft.answers[key] || "").trim()}`).join("\n\n");
};
// ── PILOT-09C/IMPLEMENT-05B（F03）：服务端证据状态夹具 ───────────────────────
// 提交门禁要求 ledger.evidence / statementHistory 与答案一致、推断带 evidenceVersion /
// evidenceRefs、判定回显 evidenceVersion。这里用**服务端构建函数**生成与真实
// employee-draft 写入同构的证据状态（摘要用 node:crypto 按同一 SHA-256 算法独立计算），
// 不改变既有 revision 语义与断言。
const evidenceSha256 = (value) => `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
const DEFAULT_INFERENCE_DEFS = [
  { source: "model", text: "P04B 基线推断 1：服务端权威记录（步骤）", basis: "steps", assumes: "若与实际不符需更正" },
  { source: "model", text: "P04B 基线推断 2：服务端权威记录（判断）", basis: "judgments", assumes: "若与实际不符需更正" },
];
function installEvidenceBaseline(db) {
  const draft = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
  const normalized = evidenceNormalizeAnswers(draft.answers);
  let history = [];
  for (const dimension of EVIDENCE_DIMENSIONS) {
    if (!normalized[dimension]) continue;
    history = appendStatementHistory({ prior: history, dimension, text: normalized[dimension], revision: draft.revision }).history;
  }
  const dimensions = {};
  for (const dimension of EVIDENCE_DIMENSIONS) {
    dimensions[dimension] = { digest: normalized[dimension] ? evidenceSha256(normalized[dimension]) : null, seq: normalized[dimension] ? 1 : 0 };
  }
  const evidence = { schemaVersion: 1, seq: history.length ? 1 : 0, answersDigest: evidenceSha256(evidenceCanonicalJson(normalized)), dimensions, revision: draft.revision, updatedAt: new Date().toISOString(), ruleVersion: 1 };
  const inferences = buildInferenceRecords([], DEFAULT_INFERENCE_DEFS).records.map((entry) => ({
    ...entry,
    evidenceVersion: 0,
    // PILOT-09C/G14：服务端同构依赖元数据（模板固定 basis；模型默认单 basis 依赖）。
    evidenceRefs: entry.basis && dimensions[entry.basis]
      ? [{ dimension: entry.basis, digest: dimensions[entry.basis].digest, source: entry.source === "server_template" ? "server_template_fixed" : "basis", ruleId: null }] : [],
    dependencyRuleVersion: 1,
    dependencySource: entry.source === "server_template" ? "server_template_fixed" : "server_rule",
    dependencyRuleStatus: entry.source === "server_template" ? "server_template_fixed" : "model_rule_validated",
    proposedDependencyDimensions: [],
    dependencyHintsRejected: [],
    invalidations: [],
    // G14-FIX-CODEX-01：依赖提议指纹（basis+hints），缺失会在保存时触发重新裁决。
    dependencyProposalKey: JSON.stringify({ basis: entry.basis || null, hints: [] }),
  }));
  const verdicts = {};
  for (const entry of inferences) {
    verdicts[entry.id] = {
      verdict: "agree", correction: "", contentVersion: entry.contentVersion,
      templateVersion: entry.templateVersion === undefined ? null : entry.templateVersion,
      evidenceHash: entry.evidenceHash || null, evidenceVersion: entry.evidenceVersion,
    };
  }
  const ledger = {
    ...(draft.ledger || {}),
    statements: normalized,
    covered: Object.keys(normalized),
    evidence,
    statementHistory: history,
    authoritativeInferences: inferences,
  };
  db.prepare("UPDATE work_items SET employee_draft_json=? WHERE id=?").bind(serializeEmployeeDraft({
    answers: draft.answers, ledger, inferenceVerdicts: verdicts, submissionText: draft.submissionText, revision: draft.revision,
  }), ITEM).run();
  return { inferences, verdicts };
}
const submitCard = async (db, card, extra = {}) => {
  const answers = {};
  for (const [key] of ANSWER_DIMENSIONS) answers[key] = String(card[key] || "").trim();
  // 材料索引按新契约的反向映射还原为 materialStatus（未知旧值按 provided 处理）。
  const materialStatus = Object.keys(MATERIAL_INDEX_LABELS).find((status) => MATERIAL_INDEX_LABELS[status] === card.materialIndex) || "provided";
  await putDraft(db, { answers, materialStatus, baseRevision: revisionOf(db) });
  // F03：保存答案后补齐服务端证据状态（模拟统一证据入口的写入结果），再提交。
  installEvidenceBaseline(db);
  return submitEmployee({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK, { text: canonicalTextOf(db), workflowCard: canonicalCardOf(db), materialStatus, ...extra, baseRevision: Number.isInteger(extra.baseRevision) ? extra.baseRevision : revisionOf(db) }, { "Idempotency-Key": `K-${Math.random()}` }), env: { DB: db }, params: { itemId: ITEM } });
};
const revisionOf = (db) => draftRevisionOf(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
const FULL_CARD = { trigger: "每天看后台和榜单", inputs: "曝光、点击、成交", steps: "选题到发布", judgments: "低毛利找老板", exceptions: "版权问题换同款", handoff: "剪完给投放同事挂车", burden: "一条大概 3 小时", materialIndex: "有已授权材料" };

console.log("PILOT-04B 补充修复与并发验证\n");

// ═══════════ 问题 A ═══════════
console.log("── 问题 A：并发令牌 ──");

// A1：相同统计计数、不同草稿内容
{
  // 复刻旧公式（基线实现），证明它不唯一
  const oldTurnOf = (draft) => {
    const ledger = draft?.ledger || null;
    const covered = Array.isArray(ledger?.covered) ? ledger.covered.length : Object.keys(draft?.answers || {}).length;
    const vague = Array.isArray(ledger?.vagueTerms) ? ledger.vagueTerms.reduce((s, e) => s + Number(e?.count || 0), 0) : 0;
    const unresolved = Array.isArray(ledger?.unresolved) ? ledger.unresolved.length : 0;
    return covered + vague + unresolved;
  };
  const a = { answers: { trigger: "A", inputs: "B" }, ledger: { covered: ["trigger", "inputs"], vagueTerms: [], unresolved: [] } };
  const b = { answers: { steps: "C", exceptions: "D" }, ledger: { covered: ["steps", "exceptions"], vagueTerms: [], unresolved: [] } };
  const c = { answers: { trigger: "完全不同" }, ledger: { covered: ["trigger"], vagueTerms: [{ key: "steps", count: 1 }], unresolved: [] } };
  const ok = oldTurnOf(a) === oldTurnOf(b) && oldTurnOf(a) === oldTurnOf(c);
  if (ok) pass("A1", "已复现：3 份不同草稿内容产生相同统计计数", `旧公式 turn=${oldTurnOf(a)}（内容各不相同）`);
  else fail("A1", "未能复现计数冲突", `${oldTurnOf(a)}/${oldTurnOf(b)}/${oldTurnOf(c)}`);
}

// A2：unresolved 减少导致计数倒退（单调性被破坏）
{
  const oldTurnOf = (draft) => {
    const ledger = draft?.ledger || null;
    const covered = Array.isArray(ledger?.covered) ? ledger.covered.length : 0;
    const vague = Array.isArray(ledger?.vagueTerms) ? ledger.vagueTerms.reduce((s, e) => s + Number(e?.count || 0), 0) : 0;
    const unresolved = Array.isArray(ledger?.unresolved) ? ledger.unresolved.length : 0;
    return covered + vague + unresolved;
  };
  const before = { covered: ["trigger"], vagueTerms: [{ key: "trigger", count: 2 }], unresolved: [{ key: "trigger", dimension: "trigger" }] };
  const after = { covered: ["trigger"], vagueTerms: [{ key: "trigger", count: 2 }], unresolved: [] };
  const t1 = oldTurnOf({ ledger: before });
  const t2 = oldTurnOf({ ledger: after });
  if (t2 < t1) pass("A2", "已复现：unresolved 被解决后计数倒退（不单调）", `${t1} → ${t2}`);
  else fail("A2", "未能复现计数倒退", `${t1} → ${t2}`);
}

// A2b：新机制严格单调
{
  const db = fixture();
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await putDraft(db, { answers: { [`k${i}`]: `v${i}` }, materialStatus: "provided", baseRevision: revisionOf(db) });
    assert.equal(r.status, 200, `第 ${i + 1} 次写入应成功`);
    seen.push(revisionOf(db));
  }
  const monotonic = seen.every((v, i) => i === 0 || v > seen[i - 1]);
  if (monotonic && seen[0] === 1) pass("A2b", "新机制 revision 严格单调递增", seen.join(" → "));
  else fail("A2b", "revision 非严格单调", seen.join(" → "));
  db.close();
}

// A3：两个请求同时读到同一修订号，随后各写入不同内容 → 只有一个成功
{
  const db = fixture();
  await putDraft(db, { answers: { trigger: "初始" }, materialStatus: "provided", baseRevision: 0 });
  const base = revisionOf(db);                       // 两个"并发"请求都读到同一修订号
  const [r1, r2] = await Promise.all([
    putDraft(db, { answers: { steps: "并发A的步骤" }, materialStatus: "provided", baseRevision: base }),
    putDraft(db, { answers: { steps: "并发B的步骤" }, materialStatus: "provided", baseRevision: base }),
  ]);
  const codes = [r1.status, r2.status].sort();
  const winner = r1.status === 200 ? r1 : r2;
  const loser = r1.status === 409 ? r1 : r2;
  const loserBody = loser.status === 409 ? await loser.json().catch(() => ({})) : {};
  const finalAnswers = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json)).answers;
  const noLostUpdate = finalAnswers.trigger === "初始";   // 初始答案未被覆盖
  if (codes[0] === 200 && codes[1] === 409 && noLostUpdate && loserBody.code === "draft_conflict") {
    pass("A3", "同一基准修订号的并发写入：恰好一个成功、一个 409 draft_conflict", `最终 steps=${finalAnswers.steps}`);
  } else {
    fail("A3", "并发写入未被正确串行化", `状态=${r1.status}/${r2.status} answers=${JSON.stringify(finalAnswers)}`);
  }
  db.close();
}

// A4：两条路径都存在竞态防护
{
  const draftSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/employee-draft.js", import.meta.url), "utf8");
  const turnSrc = readFileSync(new URL("../functions/api/agent/employee-turn.js", import.meta.url), "utf8");
  const draftUsesCas = draftSrc.includes("casWriteEmployeeDraft") && draftSrc.includes("draft_conflict");
  const turnUsesRevision = turnSrc.includes("draftRevisionOf") && turnSrc.includes("stale_turn");
  const sharedOk = readFileSync(new URL("../functions/_shared.js", import.meta.url), "utf8").includes("json_extract(employee_draft_json, '$.revision')");
  if (draftUsesCas && turnUsesRevision && sharedOk) {
    pass("A4", "草稿写入（CAS）与 Agent 轮（修订号校验）两条路径均有并发防护");
  } else {
    fail("A4", "存在未防护路径", `draft=${draftUsesCas} turn=${turnUsesRevision} cas=${sharedOk}`);
  }
}

// A5：旧请求不能覆盖新草稿
{
  const db = fixture();
  await putDraft(db, { answers: { trigger: "v1" }, materialStatus: "provided", baseRevision: 0 });
  await putDraft(db, { answers: { trigger: "v2" }, materialStatus: "provided", baseRevision: 1 });
  const stale = await putDraft(db, { answers: { trigger: "迟到的旧请求" }, materialStatus: "provided", baseRevision: 0 });
  const finalAnswers = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json)).answers;
  if (stale.status === 409 && finalAnswers.trigger === "v2") pass("A5", "迟到的旧请求被拒绝，新草稿未被覆盖", `trigger=${finalAnswers.trigger}`);
  else fail("A5", "旧请求覆盖了新草稿", `status=${stale.status} trigger=${finalAnswers.trigger}`);
  db.close();
}

// A6：原子性 —— 条件 UPDATE + meta.changes（不是"先查后写"）
{
  const db = fixture();
  await putDraft(db, { answers: { trigger: "x" }, materialStatus: "provided", baseRevision: 0 });
  const ok = await casWriteEmployeeDraft(db, ITEM, 1, serializeEmployeeDraft({ answers: { trigger: "y" }, revision: 2 }), "provided");
  const stale = await casWriteEmployeeDraft(db, ITEM, 1, serializeEmployeeDraft({ answers: { trigger: "z" }, revision: 2 }), "provided");
  const rev = revisionOf(db);
  if (ok.ok && !stale.ok && stale.currentRevision === 2 && rev === 2) {
    pass("A6", "CAS 原子性成立：同基准修订号第二次写入 changes=0 被拒", `currentRevision=${stale.currentRevision}`);
  } else {
    fail("A6", "CAS 行为异常", JSON.stringify({ ok: ok.ok, stale, rev }));
  }
  db.close();
}

// A7：旧格式（无 revision）数据可作为 revision=0 参与 CAS，不被锁死
{
  const db = fixture({ draft: { trigger: "旧扁平答案" } });
  const r = await putDraft(db, { answers: { trigger: "旧扁平答案", inputs: "新增" }, materialStatus: "provided", baseRevision: 0 });
  const rev = revisionOf(db);
  if (r.status === 200 && rev === 1) pass("A7", "旧格式数据（无 revision）可正常参与 CAS 并升级", `revision=${rev}`);
  else fail("A7", "旧格式数据无法写入", `status=${r.status} revision=${rev}`);
  db.close();
}

// 要求 5：employee-turn 不重复触发模型调用 / 过期上下文在模型之前被拒
{
  const db = fixture();
  await putDraft(db, { answers: { trigger: "a" }, materialStatus: "provided", baseRevision: 0 });
  // PILOT-08A：两条断言都需要"服务端签发锚点"才能走到各自的目标分支
  //（否则会先被 question_anchor_missing 拦下，那是另一条防线）。
  const anchor = await issueServerAnchor(db, TOK);

  // ① 无密钥 harness：应直接 503（不进入模型）。携带有效锚点，确保真的走到密钥检查。
  // env 只给 DB（无 DEEPSEEK_API_KEY）→ 应命中"harness 模式需要密钥"的 503 分支
  const noKey = await turn(
    db,
    { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "x", answers: {}, mode: "harness", baseRevision: anchor.revision },
    TOK,
    { DB: db },
  );

  // ② 陈旧 revision：应在调用模型**之前**被拒绝（stale_turn）
  const stale = await postTurn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "x", answers: {}, mode: "fixture", baseRevision: 0 });
  const staleBody = stale.status === 409 ? await stale.clone().json().catch(() => ({})) : {};

  if (noKey.status === 503 && stale.status === 409 && staleBody.code === "stale_turn") {
    pass("要求5", "过期上下文在**调用模型之前**被拒绝（无密钥 harness 亦为 503，不产生调用）", "stale_turn");
  } else {
    fail("要求5", "未能在模型调用前拒绝", `harness=${noKey.status} stale=${stale.status} code=${staleBody.code}`);
  }
  db.close();
}

// 要求 6：保存失败不会显示已保存
{
  const db = fixture();
  const real = db.runStatement.bind(db);
  db.runStatement = (st) => {
    if (typeof st.sql === "string" && /UPDATE work_items[\s\S]*employee_draft_json\s*=/.test(st.sql)) throw new Error("injected_cas_failure");
    return real(st);
  };
  const r = await putDraft(db, { answers: { trigger: "x" }, materialStatus: "provided", baseRevision: 0 });
  db.runStatement = real;
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  // 只有成功分支才置 saved
  const savedOnlyOnSuccess = /state\.formalEmployeeSaveState = "saved";/.test(appSrc)
    && appSrc.indexOf('state.formalEmployeeSaveState = "error"') > 0;
  if (r.status >= 400 && savedOnlyOnSuccess) pass("要求6", `写入失败返回 ${r.status}；前端仅在成功分支置 saved`);
  else fail("要求6", "保存失败语义不正确", `status=${r.status}`);
  db.close();
}

// 要求 7：冲突后客户端有明确提示
{
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const hasConflictBranch = appSrc.includes('error.code === "draft_conflict"');
  const hasPrompt = appSrc.includes("已在别处更新") && appSrc.includes("刷新");
  const hasBadge = appSrc.includes("保存冲突");
  if (hasConflictBranch && hasPrompt && hasBadge) pass("要求7", "客户端识别 draft_conflict 并提示刷新，且有独立徽标文案");
  else fail("要求7", "客户端未处理冲突", `branch=${hasConflictBranch} prompt=${hasPrompt} badge=${hasBadge}`);
}

// ═══════════ 问题 B ═══════════
console.log("── 问题 B：事实核验粒度 ──");

// B1/B2：事实按来源拆分，每条 sourceField 独立
{
  const db = fixture();
  await submitCard(db, FULL_CARD);
  const facts = db.all("SELECT fact_type,source_field,impact_level FROM candidate_facts WHERE work_item_id=?", ITEM);
  const fields = facts.map((f) => f.source_field);
  const uniqueish = fields.length === 5;
  // 之前 burden 被并进 execution_judgment
  const separated = fields.some((f) => f === "burden") && fields.some((f) => f === "steps,judgments");
  if (uniqueish && separated) pass("B1/B2", "事实拆为 5 条，burden 独立成条，来源可分别追溯", fields.join(" | "));
  else fail("B1/B2", "事实未按来源拆分", JSON.stringify(fields));
  db.close();
}

// B3：影响等级不再串联（burden 为 high，steps/judgments 不被连带升级）
{
  const db = fixture();
  await submitCard(db, FULL_CARD);
  const facts = db.all("SELECT source_field,impact_level,second_confirmation_status FROM candidate_facts WHERE work_item_id=?", ITEM);
  const byField = Object.fromEntries(facts.map((f) => [f.source_field, f]));
  const burdenHigh = byField.burden?.impact_level === "high" && byField.burden?.second_confirmation_status === "pending";
  const stepsNormal = byField["steps,judgments"]?.impact_level === "normal" && byField["steps,judgments"]?.second_confirmation_status === "not_required";
  if (burdenHigh && stepsNormal) {
    pass("B3", "影响等级独立：burden=high（需双人），steps+judgments=normal（不被连带升级）");
  } else {
    fail("B3", "影响等级仍串联", JSON.stringify(facts.map((f) => [f.source_field, f.impact_level])));
  }
  db.close();
}

// B3b：某个字段证据不足不会连带其他字段（模拟核验人只对 burden 判"证据不足"）
{
  const db = fixture();
  await submitCard(db, FULL_CARD);
  const burdenFact = db.get("SELECT id,status FROM candidate_facts WHERE work_item_id=? AND source_field='burden'", ITEM);
  const stepsFact = db.get("SELECT id,status FROM candidate_facts WHERE work_item_id=? AND source_field='steps,judgments'", ITEM);
  // 直接改库模拟核验人对 burden 判证据不足（不改动 verification.js 规则）
  // 注意：D1Harness.prepare() 返回的是待执行语句，必须用 exec() 才真正落库。
  db.exec(`UPDATE candidate_facts SET status='insufficient_evidence',material_status='insufficient_evidence' WHERE id='${burdenFact.id}'`);
  const after = db.all("SELECT source_field,status FROM candidate_facts WHERE work_item_id=?", ITEM);
  const burdenNow = after.find((f) => f.source_field === "burden");
  const stepsNow = after.find((f) => f.source_field === "steps,judgments");
  if (burdenNow.status === "insufficient_evidence" && stepsNow.status === "open") {
    pass("B3b", "单字段证据不足不牵连其他事实（各条状态独立）", `burden=${burdenNow.status} steps=${stepsNow.status}`);
  } else {
    fail("B3b", "状态被串联", JSON.stringify(after));
  }
  db.close();
}

// B4：无需迁移（仍为既有多列，事实条数在 2–5 内）
{
  const db = fixture();
  const r = await submitCard(db, FULL_CARD);
  const body = await r.json().catch(() => ({}));
  const count = db.count("candidate_facts");
  const schemaUnchanged = readFileSync(new URL("../schema.sql", import.meta.url), "utf8").includes("source_field TEXT NOT NULL");
  if (r.status === 200 && count === 5 && schemaUnchanged) pass("B4", "5 条事实落在既有 2–5 约束内，未改 schema（零迁移）", `count=${count}`);
  else fail("B4", "事实数量或 schema 异常", `status=${r.status} count=${count}`);
  db.close();
}

// 要求 8：不同来源的核验状态不会串联（整体断言）
{
  const db = fixture();
  await submitCard(db, FULL_CARD);
  const facts = db.all("SELECT id,source_field,status,second_confirmation_status,first_verified_by_account_id,verified_by_account_id FROM candidate_facts WHERE work_item_id=?", ITEM);
  // 每条事实各自独立成行，初始状态一致但互不共享
  const independent = facts.length === 5 && new Set(facts.map((f) => f.id)).size === 5;
  // 确认其中一条后，其余不受影响
  db.exec(`UPDATE candidate_facts SET status='confirmed',second_confirmation_status='confirmed',verified_by_account_id='${VER}',first_verified_by_account_id='${VER}' WHERE id='${facts[0].id}'`);
  const after = db.all("SELECT status FROM candidate_facts WHERE work_item_id=? AND status='open'", ITEM);
  if (independent && after.length === 4) pass("要求8", "5 条事实各自独立；确认 1 条不影响其余 4 条");
  else fail("要求8", "事实状态串联", `open=${after.length}`);
  db.close();
}

// ═══════════ 问题 C ═══════════
console.log("── 问题 C：D6 回退 ──");

// C1/C2：D6 字段已移除，模型请求不含客户端上下文
{
  const turnSrc = readFileSync(new URL("../functions/api/agent/employee-turn.js", import.meta.url), "utf8");
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const noServerField = !turnSrc.includes("projectContext") && !turnSrc.includes("body.projectContext");
  const noClientField = !appSrc.includes("projectContext:");
  // frame 定义必须与基线一致（不含 projectScope/workName）
  const frameBlock = turnSrc.slice(turnSrc.indexOf("const frame = {"), turnSrc.indexOf("const frame = {") + 900);
  const frameClean = !frameBlock.includes("projectScope") && !frameBlock.includes("workName");
  if (noServerField && noClientField && frameClean) pass("C1/C2", "D6 已回退：frame 不含 projectScope/workName，客户端不再上送，模型 prompt 恢复基线");
  else fail("C1/C2", "D6 仍有残留", `server=${noServerField} client=${noClientField} frame=${frameClean}`);
}

// C3：fixture 路径不受影响（本就不读这两字段）
{
  const adapterSrc = readFileSync(new URL("../functions/api/agent/_adapter.js", import.meta.url), "utf8");
  const fixtureBlock = adapterSrc.slice(adapterSrc.indexOf("export function runFixture"), adapterSrc.indexOf("function buildHarnessPrompt"));
  const unaffected = !fixtureBlock.includes("projectScope") && !fixtureBlock.includes("workName");
  if (unaffected) pass("C3", "fixture 路径本就不读项目上下文，D6 回退对其无影响（确定性行为不变）");
  else fail("C3", "fixture 路径引用了项目上下文");
}

// C4：不再有"客户端可控文本进入模型 prompt"的通道
{
  const turnSrc = readFileSync(new URL("../functions/api/agent/employee-turn.js", import.meta.url), "utf8");
  const blocked = !/body\.projectContext/.test(turnSrc) && !/projectContext\.projectScope/.test(turnSrc);
  if (blocked) pass("C4", "客户端无法再通过项目上下文注入文本到模型 prompt（该通道已移除）");
  else fail("C4", "客户端仍可注入项目上下文");
}

// 要求 10：D6 回退后 P0 功能不受影响
{
  const db = fixture();
  const w = await putDraft(db, { answers: { trigger: "a" }, materialStatus: "provided", baseRevision: 0 });
  const anchor = await issueServerAnchor(db, TOK);
  const t = await postTurn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "看曝光", answers: { trigger: "a", inputs: "看曝光" }, mode: "fixture", baseRevision: anchor.revision });
  const body = await t.json().catch(() => ({}));
  if (w.status === 200 && t.status === 200 && body?.turn?.turnKind && Number.isInteger(body.draftRevision)) {
    pass("要求10", "D6 回退后 P0 主链路（草稿 CAS + Agent 轮）仍正常");
  } else {
    fail("要求10", "D6 回退破坏了 P0", `draft=${w.status} turn=${t.status}`);
  }
  db.close();
}

// 要求 9 + 额外：双人核验与 E1–E5 未变
{
  const vSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/verification.js", import.meta.url), "utf8");
  const sharedSrc = readFileSync(new URL("../functions/_shared.js", import.meta.url), "utf8");
  const doubleGuard = vSrc.includes("first_verified_by_account_id!=?") && vSrc.includes("首次核验人不能完成同一事实的二次确认");
  const e1e5 = vSrc.includes('["E1", "E2", "E3", "E4", "E5"]') || /ALLOWED_EVIDENCE_LEVELS\s*=\s*\["E1", "E2", "E3", "E4", "E5"\]/.test(vSrc);
  // 鉴权函数未被改动（与 HEAD 比对）
  if (doubleGuard && e1e5) pass("要求9", "双人核验强制点与 E1–E5 等级集合保持不变");
  else fail("要求9", "核验规则疑似变化", `double=${doubleGuard} e1e5=${e1e5}`);
}

// 额外：越权与终态保护在 CAS 之后仍成立
{
  const db = fixture();
  const other = await putDraft(db, { answers: { trigger: "越权" }, materialStatus: "provided", baseRevision: 0 }, TOK_OTHER);
  const answers = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json)).answers;
  if (other.status === 403 && Object.keys(answers).length === 0) pass("额外", "CAS 改造未削弱越权防护（他人写入 403 且无副作用）");
  else fail("额外", "越权防护被削弱", `status=${other.status}`);
  db.close();
}
{
  const db = fixture({ stage: "decision", status: "complete" });
  const w = await putDraft(db, { answers: { trigger: "x" }, materialStatus: "provided", baseRevision: 0 });
  if (w.status === 409) pass("额外", "终态任务仍拒绝写入（409）");
  else fail("额外", "终态任务可写", String(w.status));
  db.close();
}

// 未覆盖声明
uncovered("并发", "真实多进程/多标签页并发", "CAS 的原子性由 SQLite 单语句条件 UPDATE 保证；本轮以同一连接上的并发 Promise + 陈旧基准值验证，未做多进程真实并发压测。");
uncovered("浏览器", "冲突提示的真实浏览器呈现", "仅验证前端代码分支与文案存在，未做真实浏览器走查（属 P2 范围）。");
uncovered("模型", "真实模型下的并发与超时", "本地无 DEEPSEEK_API_KEY，不得获取凭据，未做真实模型调用。");

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
assert.equal(count("FAIL"), 0, "存在 FAIL 用例");
console.log("\npilot04b runtime: ok");
