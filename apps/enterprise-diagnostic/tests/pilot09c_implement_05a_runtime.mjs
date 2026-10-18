/**
 * PILOT-09C/IMPLEMENT-05A —— F04 服务端可信流程卡 · 定向运行时套件（真实 handler + 内存 D1）
 *
 * 覆盖：
 *   A. B1 完整伪造八字段卡片 → 422 card_evidence_mismatch，零写入
 *   B. B2 单维度（burden）篡改 → 422，零写入；B4 materialIndex 矛盾 → 422
 *   C. B3 提交文本与服务端答案派生文本矛盾 → 422 submission_text_mismatch
 *   D. B5 等待核验人分支伪造卡片 → 422，任务保持 needs_input（不写 blocked_draft）
 *   E. B7 服务端答案缺失 + 客户端完整卡片 → 422 answers_incomplete
 *   F. 合法正常提交 → 200；candidate_facts 来自服务端规范卡；审计快照含可信来源字段
 *   G. 合法等待核验人提交 → 409 verifier_not_ready；blocked_draft；规范卡落库；无候选事实
 *   H. 旧版本 baseRevision → 409 且零写入（CAS 保护保持）
 *   I. 源码契约：candidate_facts 生成只接受 canonical card；不再直接使用 body.workflowCard
 *
 * 说明：本套件是 handler 级快速回归；真实 HTTP + 真实 wrangler/隔离 D1/真实 Chrome 的
 * RED/GREEN 证据见 PILOT-09C-IMPLEMENT-05A-evidence/（red/、green/）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendStatementHistory, buildInferenceRecords } from "../functions/api/agent/_adapter.js";
import { ANSWER_DIMENSIONS as EVIDENCE_DIMENSIONS, canonicalJson as evidenceCanonicalJson, normalizeAnswers as evidenceNormalizeAnswers } from "../functions/api/agent/_evidence.js";
import { normalizeEmployeeDraft, serializeEmployeeDraft } from "../functions/_shared.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const P = "PRJ-IMP05A", ITEM = "WI-IMP05A", EMP = "ACC-IMP05A-EMP", VER = "ACC-IMP05A-VER", TOK = "TOK-IMP05A";
const ANSWER_DIMENSIONS = [
  ["trigger", "从哪里开始"], ["inputs", "先看什么"], ["steps", "实际怎么做"],
  ["judgments", "哪些情况不能自己决定"], ["exceptions", "卡住后怎么办"],
  ["handoff", "交给谁"], ["burden", "大约多久"],
];
const ANSWERS = {
  trigger: "每天早上运营同事在群里发来当天的推广需求，我看到消息后开始处理",
  inputs: "先看昨天的曝光和点击数据，再看库存数量，然后确认投放预算还剩多少",
  steps: "先选品再写脚本，然后让剪辑同事剪出来，最后在后台提交审核并发布",
  judgments: "毛利率低于一成要先找主管确认，其他价格我自己按历史数据定",
  exceptions: "版权不确定就换同款，审核被拒就先改文案再重新提交",
  handoff: "剪完的素材交给投放同事小李，由他挂车和设置出价",
  burden: "一条视频从选题到发布大约需要三个小时，一周做五条左右",
};
const MATERIAL_LABEL = { provided: "员工已说明有材料，等待登记", none_available: "目前没有可提供的材料", undecided: "尚未选择" };
const canonicalCard = (answers = ANSWERS, materialStatus = "provided") => {
  const card = {};
  for (const [key] of ANSWER_DIMENSIONS) card[key] = String(answers[key] || "").trim();
  card.materialIndex = MATERIAL_LABEL[materialStatus];
  return card;
};
const canonicalText = (answers = ANSWERS) => ANSWER_DIMENSIONS.map(([key, label]) => `${label}：${String(answers[key] || "").trim()}`).join("\n\n");
const sameCard = (a, b) => ["trigger", "inputs", "steps", "judgments", "exceptions", "handoff", "burden", "materialIndex"].every((key) => String(a && a[key] !== undefined ? a[key] : "").trim() === String(b && b[key] !== undefined ? b[key] : "").trim());

// ── PILOT-09C/IMPLEMENT-05B（F03）：服务端证据状态夹具 ───────────────────────
// F04 套件原夹具只播种答案/推断/判定；F03 起正式提交还要求 ledger.evidence、
// statementHistory 与当前答案一致、推断带 evidenceVersion/evidenceRefs、判定回显
// evidenceVersion。这里用服务端构建函数生成与真实统一证据写入同构的状态
// （摘要用 node:crypto 按同一 SHA-256 算法独立计算），F04 的断言全部保持不变。
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

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });
const check = (id, name, ok, note = "") => (ok ? pass(id, name, note) : fail(id, name, note));

function trustedRecords(count = 2) {
  return buildInferenceRecords([], Array.from({ length: count }, (_, i) => ({
    source: "model",
    text: `IMP-05A 基线推断 ${i + 1}：服务端权威记录`,
    basis: i === 0 ? "steps" : "judgments",
    assumes: "若与实际不符需更正",
  }))).records;
}
const verdictEcho = (records) => Object.fromEntries(records.map((entry) => [entry.id, {
  verdict: "agree", correction: "",
  contentVersion: entry.contentVersion,
  templateVersion: entry.templateVersion === undefined ? null : entry.templateVersion,
  evidenceHash: entry.evidenceHash || null,
  // F03：判定必须回显条目当前 evidenceVersion。
  evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : 0,
}]));

function fixture(opts = {}) {
  const { verifierReady = true, revision = 3, answers = ANSWERS, records = trustedRecords(2), verdicts = null, status = "needs_input", materialStatus = "provided" } = opts;
  const db = new D1Harness();
  // F03：播种与真实统一证据写入同构的 evidence / statementHistory / 推断证据版本；
  // 判定按服务端条目当前版本回显（含 evidenceVersion），否则会被判 stale。
  const evidenceSeed = seedEvidenceState({ answers, inferences: records, revision, verdicts: verdicts || verdictEcho(records) });
  const draft = serializeEmployeeDraft({
    answers,
    ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: evidenceSeed.evidence, authoritativeInferences: evidenceSeed.inferences, statementHistory: evidenceSeed.history, burdenAsked: false },
    inferenceVerdicts: evidenceSeed.verdicts,
    submissionText: "",
    revision,
  });
  const invitation = verifierReady
    ? `('INV-IMP05A-VER','inv-imp05a-ver','${P}','${EMP}','ver@imp05a.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','IK-IMP05A')`
    : `('INV-IMP05A-VER','inv-imp05a-ver','${P}','${EMP}','ver@imp05a.invalid','verifier','project','pending','2099-01-01T00:00:00Z',NULL,'IK-IMP05A')`;
  const verifierMembership = verifierReady ? `INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES ('${P}','${VER}','verifier','project','active');` : "";
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@imp05a.invalid','员工甲','active','member'),
      ('${VER}','ver@imp05a.invalid','核验人乙','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage)
      VALUES ('${P}','IMP-05A 验证','选品到发布','mapping','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES ('${P}','${EMP}','employee','project','active');
    ${verifierMembership}
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-IMP05A','${P}','授权','王总','o@imp05a.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key)
      VALUES ${invitation};
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version,submission_version,employee_description,workflow_card_json)
      VALUES ('${ITEM}','${P}','还原工作','d','mapping','${status}','employee','员工甲',0,'b','n','${EMP}',
              ${verifierReady ? `'${VER}'` : "NULL"},'${draft.replace(/'/g, "''")}','${materialStatus}',1,1,0,'','{}');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R-IMP05A');
  `);
  return db;
}
const draftOf = (db) => normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
const itemOf = (db) => db.get("SELECT * FROM work_items WHERE id=?", ITEM);
const factsOf = (db) => db.all("SELECT * FROM candidate_facts WHERE work_item_id=? ORDER BY id", ITEM);
const eventsOf = (db) => db.all("SELECT type, payload FROM events WHERE work_item_id=? ORDER BY id", ITEM);
const jsonOf = async (res) => res.clone().json().catch(() => ({}));
const submit = (db, body, key = `K-${Math.random()}`) => submitEmployee({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK, body, { "Idempotency-Key": key }),
  env: { DB: db }, params: { itemId: ITEM },
});
const put = (db, body) => saveDraft({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, TOK, body),
  env: { DB: db }, params: { itemId: ITEM },
});
const bodyFor = (db, card, text = canonicalText(), extra = {}) => ({ text, workflowCard: card, materialStatus: itemOf(db).material_status, inferences: [], inferenceVerdicts: {}, baseRevision: draftOf(db).revision, ...extra });
const snapshot = (db) => {
  const item = itemOf(db);
  return JSON.stringify({
    status: item.status, stage: item.stage, submission_version: item.submission_version,
    material_status: item.material_status, employee_description: item.employee_description,
    workflow_card_json: item.workflow_card_json, revision: draftOf(db).revision,
    facts: factsOf(db).map((f) => f.claim), events: eventsOf(db).map((e) => e.type),
  });
};

console.log("PILOT-09C/IMPLEMENT-05A · F04 服务端可信流程卡 —— 定向运行时套件\n");

// A/B/C/D：完整伪造/单维度/矛盾文本/材料索引矛盾
{
  const db = fixture();
  const before = snapshot(db);
  const forged = {};
  for (const [key] of ANSWER_DIMENSIONS) forged[key] = `【B1伪造】${key} 内容与服务端答案无关`;
  forged.materialIndex = MATERIAL_LABEL.provided;
  const res = await submit(db, bodyFor(db, forged));
  const body = await jsonOf(res);
  check("B1", "B1 完整伪造八字段卡片 → 422 card_evidence_mismatch，零写入",
    res.status === 422 && body.code === "card_evidence_mismatch" && snapshot(db) === before, `${res.status} ${body.code || ""}`);
  const realCard = canonicalCard();
  const res2 = await submit(db, bodyFor(db, { ...realCard, burden: "【B2伪造】5 分钟" }));
  const body2 = await jsonOf(res2);
  check("B2", "B2 只篡改 burden → 422，零写入",
    res2.status === 422 && body2.code === "card_evidence_mismatch" && snapshot(db) === before, `${res2.status} ${body2.code || ""}`);
  const res3 = await submit(db, bodyFor(db, realCard, "【B3伪造】与答案矛盾的文本"));
  const body3 = await jsonOf(res3);
  check("B3", "B3 矛盾 text → 422 submission_text_mismatch，零写入",
    res3.status === 422 && body3.code === "submission_text_mismatch" && snapshot(db) === before, `${res3.status} ${body3.code || ""}`);
  const res4 = await submit(db, bodyFor(db, { ...realCard, materialIndex: MATERIAL_LABEL.undecided }));
  const body4 = await jsonOf(res4);
  check("B4", "B4 materialIndex 与 materialStatus 矛盾 → 422，零写入",
    res4.status === 422 && body4.code === "card_evidence_mismatch" && snapshot(db) === before, `${res4.status} ${body4.code || ""}`);
  db.close();
}

// E：等待核验人分支伪造卡片
{
  const db = fixture({ verifierReady: false });
  const before = snapshot(db);
  const forged = {};
  for (const [key] of ANSWER_DIMENSIONS) forged[key] = `【B5伪造】${key}`;
  forged.materialIndex = MATERIAL_LABEL.provided;
  const res = await submit(db, bodyFor(db, forged));
  const body = await jsonOf(res);
  const item = itemOf(db);
  check("B5", "B5 等待核验人分支伪造卡片 → 422 且不写 blocked_draft/卡片/revision",
    res.status === 422 && body.code === "card_evidence_mismatch" && item.status === "needs_input" && item.workflow_card_json === "{}" && draftOf(db).revision === 3 && factsOf(db).length === 0 && snapshot(db) === before,
    `${res.status} ${body.code || ""} status=${item.status} rev=${draftOf(db).revision}`);
  db.close();
}

// F：服务端答案缺失 + 客户端完整卡片
{
  const db = fixture();
  const draft = draftOf(db);
  const answers = { ...draft.answers };
  delete answers.steps;
  db.prepare("UPDATE work_items SET employee_draft_json=? WHERE id=?").bind(JSON.stringify({ ...draft, answers }), ITEM).run();
  const before = snapshot(db);
  const completeCard = canonicalCard(ANSWERS);
  const res = await submit(db, bodyFor(db, completeCard, canonicalText({ ...ANSWERS, steps: "补齐的客户端文本" })));
  const body = await jsonOf(res);
  check("B7", "B7 服务端缺少 steps 答案 → 422 answers_incomplete，即使客户端卡片完整",
    res.status === 422 && body.code === "answers_incomplete" && Array.isArray(body.missingDimensions) && body.missingDimensions.includes("steps") && snapshot(db) === before,
    `${res.status} ${body.code || ""} missing=${JSON.stringify(body.missingDimensions || [])}`);
  db.close();
}

// G：合法正常提交（canonical card 与文本）
{
  const db = fixture();
  const card = canonicalCard();
  const before = snapshot(db);
  const res = await submit(db, bodyFor(db, card), "K-IMP05A-OK");
  const body = await jsonOf(res);
  const item = itemOf(db);
  const facts = factsOf(db);
  const events = eventsOf(db);
  const submitted = events.find((e) => e.type === "employee_submitted");
  const payload = submitted ? JSON.parse(submitted.payload) : {};
  const claims = facts.map((f) => f.claim);
  check("OK1", "合法正常提交 → 200 awaiting_verification，5 条候选事实来自规范卡",
    res.status === 200 && item.status === "awaiting_verification" && item.submission_version === 1 && facts.length === 5 && claims.some((c) => c.includes(ANSWERS.burden)) && !claims.some((c) => c.includes("伪造")),
    `${res.status} status=${item.status} facts=${facts.length}`);
  check("OK2", "workflow_card_json 落库为服务端规范卡（与客户端一致时也是 canonical 值）",
    JSON.stringify(JSON.parse(item.workflow_card_json)) === JSON.stringify(card), item.workflow_card_json.slice(0, 80));
  check("OK3", "employee_submitted 审计快照含服务端可信来源：answersDigest/canonicalWorkflowCard/cardSource",
    typeof payload.answersDigest === "string" && payload.answersDigest.startsWith("sha256:") &&
      JSON.stringify(payload.canonicalWorkflowCard) === JSON.stringify(card) &&
      payload.cardSource === "server_canonical" && typeof payload.workflowCardDigest === "string" &&
      payload.draftRevision === draftOf(db).revision,
    `keys=${Object.keys(payload).filter((k) => ["answersDigest", "canonicalWorkflowCard", "cardSource", "workflowCardDigest"].includes(k)).join(",")}`);
  check("OK4", "合法提交新增事件仅 employee_draft_saved/employee_submitted/handoff 等既有类型，无异常写入",
    events.filter((e) => e.type === "employee_submitted").length === 1 && before !== snapshot(db),
    events.map((e) => e.type).join(","));
  db.close();
}

// H：合法等待核验人提交
{
  const db = fixture({ verifierReady: false });
  const card = canonicalCard();
  const beforeRevision = draftOf(db).revision;
  const res = await submit(db, bodyFor(db, card), "K-IMP05A-WAIT");
  const body = await jsonOf(res);
  const item = itemOf(db);
  const draft = draftOf(db);
  check("WAIT1", "合法等待核验人提交 → 409 verifier_not_ready；blocked_draft；revision N→N+1",
    res.status === 409 && body.code === "verifier_not_ready" && item.status === "blocked_draft" && draft.revision === beforeRevision + 1,
    `${res.status} ${body.code || ""} status=${item.status} rev=${beforeRevision}->${draft.revision}`);
  check("WAIT2", "等待分支落库的是服务端规范卡，无候选事实/无提交事件",
    sameCard(JSON.parse(item.workflow_card_json), card) && factsOf(db).length === 0 && !eventsOf(db).some((e) => e.type === "employee_submitted"),
    item.workflow_card_json.slice(0, 80));
  db.close();
}

// I：旧版本 baseRevision（CAS 保护保持）
{
  const db = fixture();
  const before = snapshot(db);
  const res = await submit(db, bodyFor(db, canonicalCard(), canonicalText(), { baseRevision: 2 }), "K-IMP05A-STALE");
  const body = await jsonOf(res);
  check("STALE1", "旧版本 baseRevision → 409 submission_conflict(stale_base_revision)，零写入",
    res.status === 409 && body.code === "submission_conflict" && body.reason === "stale_base_revision" && snapshot(db) === before,
    `${res.status} ${body.code || ""}/${body.reason || ""}`);
  db.close();
}

// J：源码契约
{
  const src = readFileSync(new URL("../functions/api/work-items/[itemId]/employee-submission.js", import.meta.url), "utf8");
  const hasCanonical = src.includes("function buildCanonicalWorkflowCard") && src.includes("function compareWorkflowCard") && src.includes("function canonicalSubmissionText");
  const factsFromCanonical = src.includes("candidateFactsFromWorkflowCard(formal ? canonicalSubmission.card : (body.workflowCard || {})") && !src.includes("candidateFactsFromWorkflowCard(body.workflowCard");
  const auditTrusted = src.includes('cardSource: canonicalSubmission ? "server_canonical" : "client_payload_demo"') && src.includes("answersDigest") && src.includes("canonicalWorkflowCard: auditCard") && src.includes("workflowCardDigest");
  check("SRC1", "服务端规范卡/逐字段比较/规范文本函数存在", hasCanonical, "");
  check("SRC2", "candidate_facts 只接受 canonical card（不再直接使用 body.workflowCard）", factsFromCanonical, "");
  check("SRC3", "审计快照标记服务端可信来源（cardSource/answersDigest/canonicalWorkflowCard/workflowCardDigest）", auditTrusted, "");
}

const failed = results.filter((entry) => entry.verdict === "FAIL");
console.log("\n──────────────── 结果明细 ────────────────");
for (const entry of results) {
  console.log(`  ${entry.verdict === "PASS" ? "✔" : "✘"} [${entry.verdict}] ${entry.id} · ${entry.name}${entry.note ? "\n        " + entry.note : ""}`);
}
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${results.length - failed.length}  FAIL=${failed.length}`);
if (failed.length) {
  console.error(`\n  IMPLEMENT-05A 定向套件失败 ${failed.length} 项：${failed.map((entry) => entry.id).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("  pilot09c implement-05a runtime: ok");
}
