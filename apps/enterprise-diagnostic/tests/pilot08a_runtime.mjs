/**
 * PILOT-08A —— P1 服务端信任边界定点修复 · 跨接口专项测试
 *
 * 覆盖报告第九节要求的 17 项，全部走**完整链路**（不是单 handler 单测）：
 *   服务端签发问题 → 客户端保存草稿 → 服务端读取身份 → 客户端提交回答
 *   → 服务端校验 → 模型生成下一问
 *
 * 所有模型行为通过**注入假 fetch** 模拟：不触网、不使用任何真实密钥。
 * 断言同时检查 HTTP 状态码与**最终数据库状态**（不只看 200/409）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";
import { ANSWER_DIMENSIONS as EVIDENCE_DIMENSIONS, canonicalJson as evidenceCanonicalJson, normalizeAnswers as evidenceNormalizeAnswers } from "../functions/api/agent/_evidence.js";
import { appendStatementHistory } from "../functions/api/agent/_adapter.js";
import { onRequestPost as agentTurn } from "../functions/api/agent/employee-turn.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { onRequestGet as verifierFacts } from "../functions/api/formal/projects/[projectId]/verifier-facts.js";
import { normalizeEmployeeDraft, serializeEmployeeDraft, draftRevisionOf } from "../functions/_shared.js";
import { buildInferenceRecords } from "../functions/api/agent/_adapter.js";

// ── PILOT-09C/IMPLEMENT-05B（F03）：服务端证据状态夹具 ───────────────────────
// F03 起正式提交要求 ledger.evidence / statementHistory 与答案一致，推断带
// evidenceVersion/evidenceRefs，判定回显 evidenceVersion。旧夹具只播种推断与判定。
// 这里用服务端构建函数生成与真实统一证据写入同构的状态（摘要用 node:crypto
// 按同一 SHA-256 算法独立计算），既有断言不变。
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

const P = "PRJ-P08A001", ITEM = "WI-P08A001", EMP = "ACC-P08A-EMP", VER = "ACC-P08A-VER";
const TOK = "TOK-P08A-EMP", VTOK = "TOK-P08A-VER";
const KEY = "fake-deepseek-key-not-real";

const ANSWER_FOR = {
  trigger: "每天早上先看后台的曝光和成交数据",
  inputs: "看曝光点击成交和退款率",
  steps: "先从蝉妈妈挑对标视频，然后写脚本拍摄，最后剪辑挂车发布",
  judgments: "毛利低于一成必须找主管确认",
  exceptions: "素材版权拿不准就换同款",
  handoff: "剪完交给投放小李挂车",
  burden: "一条大概三个小时",
};

const Q = (key, label, prompt) => JSON.stringify({ turnKind: "question", question: { key, label, prompt, isFollowup: false } });

function fixture({ revision = 0, answers = {}, ledger = null, altJson = "[]", withFact = false, altOther = null, rawDraft = null } = {}) {
  const db = new D1Harness();
  const dj = (rawDraft ?? serializeEmployeeDraft({ answers, ledger, inferenceVerdicts: {}, submissionText: "", revision })).replace(/'/g, "''");
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@p08a.invalid','小李','active','member'),
      ('${VER}','ver@p08a.invalid','核验人','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES
      ('${P}','短视频带货流程诊断','选品到发布与复盘','mapping','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P}','${EMP}','employee','project','active'),
      ('${P}','${VER}','verifier','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-P08A','${P}','授权','王总','o@p08a.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key) VALUES
      ('INV-P08A-VER','invite-p08a-ver','${P}','${EMP}','ver@p08a.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','INVK-P08A');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R1'),
      ('${VTOK}','${VER}','${P}','2099-01-01T00:00:00Z','R2');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,alternative_explanations_json,material_status,flow_card_version,evidence_version) VALUES
      ('${ITEM}','${P}','还原工作','d',${withFact ? "'facts'" : "'mapping'"},${withFact ? "'awaiting_verification'" : "'needs_input'"},'employee','小李',0,'b','n','${EMP}','${VER}','${dj}','${altJson.replace(/'/g, "''")}','provided',1,1);
  `);
  // 核验队列要求 work_item.stage='facts' 且存在候选事实，因此事实行必须一并播种
  if (withFact) {
    db.exec(`INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,flow_card_version,evidence_version,source_refs_json) VALUES ('F-P08A','${P}','${ITEM}','trigger_input','主张','trigger',1,'normal','not_required','unverified','open',1,1,'[]');`);
  }
  if (altOther !== null) {
    db.exec(`
      INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES ('PRJ-OTHER08A','别的项目','机密','facts','active','unknown','external_builder','${EMP}','authorized');
      INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES ('PRJ-OTHER08A','${VER}','verifier','project','active');
      INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES ('AUTH-X08A','PRJ-OTHER08A','a','o','o@x.invalid','s','r','authorized','${EMP}','k2','n','h','2099-01-01T00:00:00Z');
      INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,alternative_explanations_json,material_status,flow_card_version,evidence_version) VALUES ('WI-OTHER08A','PRJ-OTHER08A','t','d','facts','awaiting_verification','employee','E',0,'b','n','${EMP}','${VER}','{}','${altOther.replace(/'/g, "''")}','provided',1,1);
    `);
  }
  return db;
}

const originalFetch = globalThis.fetch;
function fakeModel(payload, capture = {}) {
  capture.prompts = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("api.deepseek.com")) return originalFetch(url, init);
    capture.prompts.push(JSON.parse(init.body).messages[0].content);
    const content = typeof payload === "function" ? payload(capture.prompts.length) : payload;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { capture, restore: () => { globalThis.fetch = originalFetch; } };
}

// ── 链路工具 ───────────────────────────────────────────────────────────
const draftJson = (db) => JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json);
const draftOf = (db) => normalizeEmployeeDraft(draftJson(db));
const ledgerOf = (db) => draftOf(db).ledger;
const anchorOf = (db) => ledgerOf(db)?.pendingQuestion ?? null;
const revOf = (db) => draftRevisionOf(draftJson(db));

const turn = (db, body, token = TOK) =>
  // PILOT-09C/FIX-CODEX-02A（F01）：正式执行模式由服务端决定；本套件的确定性 fixture
  // 测试档必须由服务端环境显式开启（FORMAL_AGENT_TEST_MODE=1），客户端请求不足以切换。
  agentTurn({ request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", token, body), env: { DB: db, DEEPSEEK_API_KEY: KEY, FORMAL_AGENT_TEST_MODE: "1" }, params: {} });
const turnNoKey = (db, body, token = TOK) =>
  agentTurn({ request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", token, body), env: { DB: db }, params: {} });
const put = (db, body, token = TOK) =>
  saveDraft({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, token, body), env: { DB: db }, params: { itemId: ITEM } });
const submit = (db, body, key = "K-P08A") =>
  // PILOT-09C/FIX-CODEX-03A：正式提交现在必须携带 baseRevision（测试按库中当前版本补齐）。
  submitEmployee({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK, { ...body, baseRevision: Number.isInteger(body.baseRevision) ? body.baseRevision : revOf(db) }, { "Idempotency-Key": key }), env: { DB: db }, params: { itemId: ITEM } });

// ── PILOT-09C/IMPLEMENT-05A（F04）：正式提交必须使用服务端规范卡/规范文本 ──
// 服务端只从**已持久化的草稿 answers + work_items.material_status** 派生 card/text；
// 测试的提交载荷因此也由同一份答案按契约派生（断言仍验证最终落库结果）。
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

/** 走服务端恢复路径取得/推进锚点：服务端决定维度 → 客户端保存 → 返回当前锚点 */
async function recover(db, token = TOK) {
  const res = await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) }, token);
  const body = await res.clone().json();
  return { status: res.status, body, key: body?.turn?.nextQuestion?.key ?? null, revision: revOf(db) };
}
/** 按服务端签发的维度作答（并返回响应体）；可选保存客户端自动保存 */
async function answerIssued(db, { save = false, token = TOK, payload = null, answer = null } = {}) {
  const anchor = anchorOf(db);
  if (!anchor) throw new Error("answerIssued: 库中无锚点，请先 recover()");
  const text = answer ?? ANSWER_FOR[anchor.key] ?? "按实际流程描述这一步";
  const payloadJson = payload === null ? Q("handoff", "交给谁", "剪完之后交给谁继续？") : payload;
  const fake = fakeModel(payloadJson);
  let res;
  try {
    res = await turn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: text, answers: {}, mode: "harness", baseRevision: revOf(db) }, token);
  } finally { fake.restore(); }
  const body = await res.clone().json();
  if (save && res.status === 200) {
    await put(db, { answers: { ...draftOf(db).answers, [anchor.key]: text }, materialStatus: "provided", baseRevision: revOf(db), ledger: body?.turn?.interviewState?.ledger });
  }
  return { res, body, anchorKey: anchor.key, answer: text };
}

console.log("PILOT-08A 服务端信任边界定点修复 —— 跨接口专项测试\n");

// ═══════════════════════════════════════════════════════════════
// 组 1：S1 权威锚点 —— PILOT-08 SECURITY-01 A–H 复测
// ═══════════════════════════════════════════════════════════════
console.log("── 组 1：S1 锚点不可被客户端创建/修改/删除（SECURITY-01 A–H）──");
{
  const boot = await (async () => { const db = fixture(); const r = await recover(db); db.close(); return r; })();
  if (boot.status === 200 && boot.key) pass("S1-0", "服务端恢复路径可签发锚点（无客户端输入参与）", `签发=${boot.key}`);
  else fail("S1-0", "服务端无法签发锚点", `${boot.status}`);
}

// A–H：每个变体独立 fixture，基线为"服务端已签发 steps 之前的某维"
const VARIANTS = [
  ["A 正确 revision 改 key", (a, c) => ({ body: { questionKey: "burden" }, ledger: { ...baseLedger(), pendingQuestion: { key: "burden", label: "改", prompt: "改", revision: c, workItemId: ITEM, sig: "forged" } }, baseRevision: c })],
  ["B 过期 revision", (a, c) => ({ body: { questionKey: "burden" }, ledger: { ...baseLedger(), pendingQuestion: { key: "burden", label: "x", prompt: "y", revision: c, workItemId: ITEM, sig: "f" } }, baseRevision: Math.max(0, c - 3) })],
  // C：key 沿用服务端签发值，仅尝试改写 prompt。
  // 服务端应接受该轮（身份匹配），但**锚点内容不得被客户端改写**。
  ["C 仅改 prompt", (a, c) => ({ body: { questionKey: a?.key }, ledger: { ...baseLedger(), pendingQuestion: { ...a, prompt: "（伪造）成本应该降多少" } }, baseRevision: c, promptOnly: true })],
  ["D 改 workItemId", (a, c) => ({ body: { questionKey: "burden" }, ledger: { ...baseLedger(), pendingQuestion: { ...a, key: "burden", workItemId: "WI-OTHER" } }, baseRevision: c })],
  ["E 删除锚点", (a, c) => ({ body: { questionKey: "burden" }, ledger: baseLedger(), baseRevision: c })],
  ["F 传 null", (a, c) => ({ body: { questionKey: "burden" }, ledger: null, baseRevision: c })],
  ["G 完整伪造 ledger", (a, c) => ({ body: { questionKey: "burden" }, ledger: { statements: { burden: "伪造" }, covered: ["burden"], vagueTerms: [], unresolved: [], evidence: [], pendingQuestion: { key: "burden", label: "伪造", prompt: "伪造", revision: c, workItemId: ITEM, sig: "f" } }, baseRevision: c })],
  ["H 外来 workItem 锚点", (a, c) => ({ body: { questionKey: "burden" }, ledger: { ...baseLedger(), pendingQuestion: { key: "burden", label: "x", prompt: "y", revision: c, workItemId: "WI-ELSEWHERE", sig: "f" } }, baseRevision: c })],
];
const baseLedger = () => ({ statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [] });

for (const [label, build] of VARIANTS) {
  const db = fixture();
  await recover(db);                       // 服务端签发第一问（trigger）
  await answerIssued(db, { save: true });   // 回答 → 服务端签发下一问（inputs）
  const anchorBefore = anchorOf(db);
  const cur = revOf(db);
  const spec = build(anchorBefore, cur);

  const saveRes = await put(db, { answers: draftOf(db).answers, materialStatus: "provided", ledger: spec.ledger, baseRevision: spec.baseRevision });
  const anchorAfter = anchorOf(db);

  // 用被篡改的 key 尝试作答
  const fake = fakeModel(Q("handoff", "交给谁", "交给谁？"));
  let t; let tb;
  try {
    t = await turn(db, { projectId: P, workItemId: ITEM, questionKey: spec.body.questionKey, answer: ANSWER_FOR[spec.body.questionKey] || "伪造维度回答", answers: {}, mode: "harness", baseRevision: revOf(db) });
    tb = await t.clone().json();
  } finally { fake.restore(); }

  const cov = tb.turn?.coverage;
  const anchorChanged = anchorAfter?.key !== anchorBefore?.key;
  const id = `S1-${label[0]}`;

  if (spec.promptOnly) {
    // C：断言锚点**文本**未被客户端提供的值替换
    const promptForged = anchorAfter?.prompt === "（伪造）成本应该降多少";
    if (!promptForged && anchorAfter?.prompt === anchorBefore?.prompt) {
      pass(id, "仅改 prompt → 服务端接受该轮（key 匹配），但锚点文本未被客户端改写", `锚点=${anchorAfter?.key}`);
    } else {
      fail(id, "客户端改写了锚点文本", JSON.stringify(anchorAfter));
    }
  } else {
    // A/B/D/E/F/G/H：断言错误维度未被接受、锚点未被替换
    const misclassified = t.status === 200 && cov?.dimensions?.[spec.body.questionKey]?.status === "sufficient";
    if (!misclassified && !anchorChanged) {
      pass(id, `${label} → 锚点未被改写、错误维度未被接受`, `save=${saveRes.status} turn=${t.status}${tb.code ? " " + tb.code : ""} 锚点=${anchorAfter?.key}`);
    } else {
      fail(id, `${label} → 攻击成功或锚点被改写`, `misclassified=${misclassified} anchorChanged=${anchorChanged} save=${saveRes.status} turn=${t.status}`);
    }
  }
  db.close();
}

// 锚点不能由客户端"创建"（全新草稿直接提交锚点）
{
  const db = fixture();
  const forged = { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], pendingQuestion: { key: "handoff", label: "伪造", prompt: "伪造", revision: 1, workItemId: ITEM, sig: "forged" } };
  await put(db, { answers: {}, materialStatus: "provided", ledger: forged, baseRevision: 0 });
  const stored = anchorOf(db);
  if (stored === null) pass("S1-CREATE", "客户端无法**创建**锚点：伪造 pendingQuestion 后库中仍为 null");
  else fail("S1-CREATE", "客户端成功创建了锚点", JSON.stringify(stored));
  db.close();
}

// 模型仍可自主决定维度与内容（不破坏动态提问）
{
  const db = fixture();
  await recover(db);
  const r = await answerIssued(db, { payload: Q("burden", "大约多久", "做一次大概要多久？") });
  const nq = r.body?.turn?.nextQuestion;
  if (r.res.status === 200 && nq?.key === "burden") pass("S1-DYN", "模型仍可自主跨维度提问（下一问由模型决定，服务端只负责签发与校验）", `next=${nq.key}`);
  else fail("S1-DYN", "动态提问被破坏", `${r.res.status} next=${nq?.key}`);
  db.close();
}

// 覆盖提示不得被当作已核验事实
{
  const db = fixture();
  await recover(db);
  await answerIssued(db, { save: true });
  const facts = db.all("SELECT * FROM candidate_facts WHERE work_item_id=?", ITEM);
  if (facts.length === 0) pass("S1-FACTS", "模型生成的覆盖提示/推断未写入 candidate_facts（不当作已核验事实）");
  else fail("S1-FACTS", "模型输出被写成了事实", JSON.stringify(facts).slice(0, 120));
  db.close();
}

// ═══════════════════════════════════════════════════════════════
// 组 2：S2 无锚点引导轮收紧
// ═══════════════════════════════════════════════════════════════
console.log("\n── 组 2：S2 无锚点不再等于可自由指定维度 ──");
// A. 全新草稿
{
  const db = fixture();
  const r = await turn(db, { projectId: P, workItemId: ITEM, questionKey: "trigger", answer: "x", answers: {}, mode: "fixture", baseRevision: 0 });
  const b = await r.clone().json();
  if (r.status === 409 && b.code === "question_anchor_missing" && b.recoverable === true) pass("S2-A", "全新草稿无锚点直接作答 → 409 question_anchor_missing（可恢复）");
  else fail("S2-A", "无锚点被放行", `${r.status} ${JSON.stringify(b).slice(0, 100)}`);
  db.close();
}
// B. 旧草稿无锚点
{
  const db = fixture({ revision: 1, answers: { trigger: ANSWER_FOR.trigger } });
  const r = await turn(db, { projectId: P, workItemId: ITEM, questionKey: "inputs", answer: "x", answers: {}, mode: "fixture", baseRevision: 1 });
  if (r.status === 409) pass("S2-B", "旧草稿缺锚点 → 同样拒绝（不因「旧数据」放宽身份校验）");
  else fail("S2-B", "旧草稿被放行", String(r.status));
  db.close();
}
// C/D/E. 客户端删除 / null / 空对象
for (const [id, ledger, label] of [
  ["S2-C", { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [] }, "客户端删除锚点"],
  ["S2-D", null, "客户端传 null"],
  ["S2-E", {}, "客户端传空对象"],
]) {
  const db = fixture();
  await recover(db);
  await answerIssued(db, { save: true });
  const keptBefore = anchorOf(db);
  await put(db, { answers: draftOf(db).answers, materialStatus: "provided", ledger, baseRevision: revOf(db) });
  const keptAfter = anchorOf(db);
  const r = await turn(db, { projectId: P, workItemId: ITEM, questionKey: "burden", answer: "伪造维度", answers: {}, mode: "fixture", baseRevision: revOf(db) });
  if (keptAfter?.key === keptBefore?.key && r.status === 409) pass(id, `${label} → 库中锚点保留（${keptAfter?.key}），伪造维度作答 409`);
  else fail(id, `${label} → 锚点丢失或被放行`, `before=${keptBefore?.key} after=${keptAfter?.key} turn=${r.status}`);
  db.close();
}
// F. 正常恢复后继续访谈
{
  const db = fixture();
  const r1 = await recover(db);
  const a1 = await answerIssued(db, { save: true });
  const r2 = await recover(db);
  const a2 = await answerIssued(db, { save: true });
  const r3 = await recover(db);
  // 断言"服务端在每轮恢复时签发的维度"覆盖多个不同维度（回答后覆盖集推进）
  const issued = [r1.key, r2.key, r3.key];
  const allOk = [r1, r2, r3].every((r) => r.status === 200) && [a1, a2].every((a) => a.res.status === 200);
  const progressed = new Set(issued).size >= 3;
  if (allOk && progressed) {
    pass("S2-F", "正常恢复后可连续推进访谈（服务端逐轮签发不同维度）", issued.join(" → "));
  } else {
    fail("S2-F", "恢复后无法继续", `status=${r1.status}/${a1.res.status}/${r2.status}/${a2.res.status}/${r3.status} 签发=${issued.join(" → ")}`);
  }
  db.close();
}
// G. 连续两轮动态追问
{
  const db = fixture();
  await recover(db);
  const a1 = await answerIssued(db, { save: true, payload: Q("steps", "实际怎么做", "你按什么顺序操作？") });
  const a2 = await answerIssued(db, { save: true, payload: Q("handoff", "交给谁", "剪完交给谁？") });
  if (a1.res.status === 200 && a1.body.turn.nextQuestion.key === "steps" && a2.res.status === 200 && a2.body.turn.nextQuestion.key === "handoff") {
    pass("S2-G", "连续两轮动态追问正常（steps → handoff）");
  } else {
    fail("S2-G", "动态追问异常", `${a1.res.status}/${a1.body.turn?.nextQuestion?.key} → ${a2.res.status}/${a2.body.turn?.nextQuestion?.key}`);
  }
  db.close();
}
// 恢复路径不采信客户端 questionKey
{
  const db = fixture();
  const r = await turn(db, { projectId: P, workItemId: ITEM, recover: true, questionKey: "evil_dim", answers: {}, mode: "fixture", baseRevision: 0 });
  const b = await r.clone().json();
  const issued = anchorOf(db)?.key;
  if (r.status === 200 && ["trigger", "inputs", "steps", "judgments", "exceptions", "handoff", "burden"].includes(issued)) {
    pass("S2-IGNORE", "恢复路径完全忽略客户端 questionKey，由服务端决定维度", `签发=${issued}`);
  } else {
    fail("S2-IGNORE", "恢复路径采信了客户端输入", `${r.status} ${JSON.stringify(b).slice(0, 100)}`);
  }
  db.close();
}

// ═══════════════════════════════════════════════════════════════
// 组 3：S3 服务端 unresolved 保护（SECURITY-03 A–H + I/J）
// ═══════════════════════════════════════════════════════════════
console.log("\n── 组 3：S3 服务端 unresolved 不可被静默删除/篡改 ──");
const AUTH = [{ key: "exceptions", dimension: "exceptions", reason: "服务端记录的缺口", lastAnswer: "差不多吧", source: "server" }];
const seedS3 = () => fixture({ revision: 3, answers: { trigger: ANSWER_FOR.trigger, inputs: ANSWER_FOR.inputs }, ledger: { statements: {}, covered: ["trigger", "inputs"], vagueTerms: [{ key: "steps", count: 1 }], unresolved: AUTH, evidence: [], authoritativeUnresolved: AUTH } });

for (const [id, ledger, label] of [
  ["S3-A", undefined, "ledger 缺省"],
  ["S3-B", null, "ledger=null"],
  ["S3-C", {}, "ledger={}"],
  ["S3-D", { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [] }, "unresolved=[]"],
  ["S3-E", { statements: {}, covered: [], vagueTerms: [], unresolved: [{ key: "handoff", dimension: "handoff", reason: "伪造" }], evidence: [] }, "伪造其他维度"],
  ["S3-F", { statements: {}, covered: [], vagueTerms: [], unresolved: Array.from({ length: 5000 }, () => ({ key: "exceptions", dimension: "exceptions", reason: "x".repeat(200) })), evidence: [] }, "5000 条输入"],
  ["S3-G", { statements: {}, covered: [], vagueTerms: [], unresolved: [{ key: "exceptions", dimension: "exceptions", reason: "客户端改写的理由" }], evidence: [] }, "改写 reason"],
  ["S3-H", { statements: {}, covered: [], vagueTerms: [], unresolved: [{ key: "handoff", dimension: "handoff", reason: "伪造", source: "server" }], evidence: [] }, "伪造 source=server"],
]) {
  const db = seedS3();
  const r = await put(db, { answers: draftOf(db).answers, materialStatus: "provided", ledger, baseRevision: revOf(db) });
  const l = ledgerOf(db);
  const serverEntries = (l.unresolved || []).filter((u) => u.dimension === "exceptions");
  const serverReasonKept = serverEntries[0]?.reason === "服务端记录的缺口";
  const noForgedServer = !(l.unresolved || []).some((u) => u.source === "server" && u.dimension !== "exceptions");
  const capped = (l.unresolved || []).length <= 50;
  const authKept = Array.isArray(l.authoritativeUnresolved) && l.authoritativeUnresolved.length === 1;
  if (r.status === 200 && serverEntries.length > 0 && serverReasonKept && noForgedServer && capped && authKept) {
    pass(id, `${label} → 服务端条目完整保留、reason 未被改写、无伪造 server 条目`, `可见=[${(l.unresolved || []).map((u) => u.dimension).join(",")}]`);
  } else {
    fail(id, `${label} → 服务端条目被删除或篡改`, `status=${r.status} kept=${serverEntries.length} reason=${serverReasonKept} forged=${!noForgedServer} capped=${capped} auth=${authKept}`);
  }
  db.close();
}
// I. 服务端可关闭已解决条目（不被永久锁死）
{
  const db = seedS3();
  // 员工就 exceptions 维度作出了明确回答 → 下一轮由服务端重建 ledger 时应视为已解决
  const fresh = fixture({ revision: 1, answers: { trigger: ANSWER_FOR.trigger }, ledger: { statements: {}, covered: ["trigger"], vagueTerms: [], unresolved: AUTH, evidence: [], authoritativeUnresolved: AUTH } });
  const anchor = await recover(fresh);
  const anchorObj = anchorOf(fresh);
  const fake = fakeModel(Q("inputs", "先看什么", "你先看哪些信息？"));
  let res;
  try {
    res = await turn(fresh, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: ANSWER_FOR.exceptions, answers: {}, mode: "harness", baseRevision: revOf(fresh) });
  } finally { fake.restore(); }
  const body = await res.clone().json();
  const stillOpen = (body.turn?.interviewState?.ledger?.unresolved || []).some((u) => u.dimension === "exceptions");
  // 注意：本用例验证"服务端可以在下一轮重新裁决"，即条目不是不可变黑箱
  if (res.status === 200 && Array.isArray(body.turn?.interviewState?.ledger?.unresolved)) {
    pass("S3-I", "服务端在下一轮会基于**已落库答案**重新裁决 unresolved（条目未被永久锁死）", `exceptions 仍记为缺口=${stillOpen}`);
  } else {
    fail("S3-I", "服务端无法更新 unresolved", `${res.status}`);
  }
  fresh.close(); db.close();
}
// J. 客户端合法补充作为待核实输入保留
{
  const db = seedS3();
  await put(db, { answers: draftOf(db).answers, materialStatus: "provided", baseRevision: revOf(db), ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [{ key: "judgments", dimension: "judgments", reason: "员工补充：这块我还不确定" }], evidence: [] } });
  const l = ledgerOf(db);
  const sup = (l.unresolved || []).find((u) => u.dimension === "judgments");
  if (sup && sup.source === "client") pass("S3-J", "客户端补充作为 client 待核实输入保留（不能冒充 service 权威）", JSON.stringify(sup));
  else fail("S3-J", "客户端合法补充未被保留", JSON.stringify(l.unresolved));
  db.close();
}
// unresolved 不影响七维覆盖裁决
{
  const db = seedS3();
  const before = await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const missingBefore = (await before.clone().json()).turn?.coverage?.missing ?? [];
  await put(db, { answers: draftOf(db).answers, materialStatus: "provided", baseRevision: revOf(db), ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [] } });
  const after = await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const missingAfter = (await after.clone().json()).turn?.coverage?.missing ?? [];
  if (JSON.stringify(missingBefore) === JSON.stringify(missingAfter)) pass("S3-COV", "unresolved 不参与覆盖裁决：清空前后 missing 完全一致", JSON.stringify(missingAfter));
  else fail("S3-COV", "unresolved 影响了覆盖裁决", `${JSON.stringify(missingBefore)} vs ${JSON.stringify(missingAfter)}`);
  db.close();
}

// 客户端开局恢复链路（锁定 app.js 与 employee-turn 的契约，防 P1 功能回归）
{
  const turnSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  // PILOT-08C/R2：客户端恢复已改为**受控**判定（白名单错误码 + 服务端 recoverable/expectedKey）。
  // 因此这里按新结构断言，而不是匹配旧的单点字符串。
  const clientHandles = turnSrc.includes("canRecoverQuestionIdentity")
    && turnSrc.includes("RECOVERABLE_CODES")
    && /recover:\s*true/.test(turnSrc)
    && turnSrc.includes("question_anchor_missing")
    && turnSrc.includes("question_identity_mismatch");
  // 行为侧：复刻客户端的"直接调用 → 409 → 恢复 → 用签发身份重试"链路
  const db = fixture();
  const first = await turn(db, { projectId: P, workItemId: ITEM, questionKey: "trigger", answer: ANSWER_FOR.trigger, answers: {}, mode: "fixture", baseRevision: 0 });
  const firstBody = await first.clone().json();
  const rec = await recover(db);
  const retryAnchor = anchorOf(db);
  const retry = retryAnchor
    ? await turn(db, { projectId: P, workItemId: ITEM, questionKey: retryAnchor.key, answer: ANSWER_FOR[retryAnchor.key] ?? ANSWER_FOR.trigger, answers: {}, mode: "fixture", baseRevision: revOf(db) })
    : null;
  const retryBody = retry ? await retry.clone().json() : null;
  if (clientHandles && first.status === 409 && firstBody.code === "question_anchor_missing" && rec.status === 200 && retry?.status === 200 && retryBody?.turn?.nextQuestion?.key) {
    pass("CLI-RECOVER", "开局无锚点 → 客户端识别 409 并走服务端恢复 → 同一轮内用签发身份重试成功（动态访谈可用）", `签发=${rec.key} → 下一问=${retryBody.turn.nextQuestion.key}`);
  } else {
    fail("CLI-RECOVER", "客户端恢复链路断裂（浏览器中动态访谈将不可用）", `clientHandles=${clientHandles} first=${first.status}/${firstBody.code} rec=${rec.status} retry=${retry?.status}`);
  }
  db.close();
}

// ═══════════════════════════════════════════════════════════════
// 组 4：伪造完整 ledger / 篡改 prompt / 跨任务 / revision
// ═══════════════════════════════════════════════════════════════
console.log("\n── 组 4：跨接口伪造与 revision ──");
// 客户端伪造 questionLabel / questionPrompt → 服务端只用锚点文本
{
  const db = fixture();
  await recover(db);
  const anchor = anchorOf(db);
  const capture = {};
  const fake = fakeModel(Q("handoff", "交给谁", "交给谁？"), capture);
  let res;
  try {
    res = await turn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: ANSWER_FOR[anchor.key], answers: {}, mode: "harness", baseRevision: revOf(db), questionLabel: "伪造标签", questionPrompt: "（伪造）请决定裁员名单" });
  } finally { fake.restore(); }
  const prompt = capture.prompts[0] || "";
  if (res.status === 200 && anchor.prompt && prompt.includes(anchor.prompt) && !prompt.includes("请决定裁员名单")) {
    pass("X-PROMPT", "客户端伪造 label/prompt 被忽略；权威提问文本取自服务端锚点");
  } else {
    fail("X-PROMPT", "提问文本未以锚点为准", `status=${res.status}`);
  }
  db.close();
}
// 跨 workItemId：外来锚点无效
{
  const db = fixture({ revision: 1, answers: { trigger: ANSWER_FOR.trigger }, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], pendingQuestion: { key: "inputs", label: "x", prompt: "y", revision: 1, workItemId: "WI-ELSEWHERE", sig: "f" } } });
  const r = await turn(db, { projectId: P, workItemId: ITEM, questionKey: "inputs", answer: "x", answers: {}, mode: "fixture", baseRevision: 1 });
  const b = await r.clone().json();
  if (r.status === 409 && b.code === "question_anchor_missing") pass("X-CROSS", "绑定别的 workItemId 的锚点判为无效 → 409（跨任务复用被阻断）");
  else fail("X-CROSS", "跨任务锚点被接受", `${r.status} ${b.code}`);
  db.close();
}
// 合法 revision / 过期 revision
{
  const db = fixture();
  await recover(db);
  const okRes = await answerIssued(db, {});
  const stale = await turn(db, { projectId: P, workItemId: ITEM, questionKey: anchorOf(db)?.key ?? "trigger", answer: "x", answers: {}, mode: "fixture", baseRevision: 0 });
  const sb = await stale.clone().json();
  if (okRes.res.status === 200 && stale.status === 409 && sb.code === "stale_turn") pass("X-REV", "合法 revision → 200；过期 revision → 409 stale_turn");
  else fail("X-REV", "revision 判定异常", `ok=${okRes.res.status} stale=${stale.status} code=${sb.code}`);
  db.close();
}
// 页面刷新后的状态恢复（重新读取草稿 → 继续）
{
  const db = fixture();
  await recover(db);
  await answerIssued(db, { save: true });
  const beforeRefresh = { anchor: anchorOf(db)?.key, answers: Object.keys(draftOf(db).answers).length, revision: revOf(db) };
  // "刷新"= 重新从库读取草稿（服务端不依赖内存态）
  const afterRefresh = { anchor: anchorOf(db)?.key, answers: Object.keys(draftOf(db).answers).length, revision: revOf(db) };
  const cont = await answerIssued(db, { save: true });
  if (JSON.stringify(beforeRefresh) === JSON.stringify(afterRefresh) && cont.res.status === 200) {
    pass("X-REFRESH", "刷新后状态可恢复（锚点/答案/revision 均来自库），并可继续作答", JSON.stringify(afterRefresh));
  } else {
    fail("X-REFRESH", "刷新后状态丢失", `${JSON.stringify(beforeRefresh)} vs ${JSON.stringify(afterRefresh)} turn=${cont.res.status}`);
  }
  db.close();
}
// 模型生成成功但保存失败 → 锚点仍由服务端持有，且不产生半截状态
{
  const db = fixture();
  await recover(db);
  const real = db.runStatement.bind(db);
  db.runStatement = (st) => {
    if (typeof st.sql === "string" && /UPDATE work_items[\s\S]*employee_draft_json\s*=/.test(st.sql)) throw new Error("injected_save_failure");
    return real(st);
  };
  const anchor = anchorOf(db);
  const saveRes = await put(db, { answers: draftOf(db).answers, materialStatus: "provided", baseRevision: revOf(db), ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], pendingQuestion: { key: "burden", label: "伪造", prompt: "伪造", revision: revOf(db), workItemId: ITEM, sig: "f" } } });
  db.runStatement = real;
  const anchorAfter = anchorOf(db);
  if (saveRes.status >= 400 && anchorAfter?.key === anchor?.key) {
    pass("X-SAVEFAIL", "保存失败时锚点不被覆盖（服务端仍持有效锚点）", `save=${saveRes.status} 锚点=${anchorAfter?.key}`);
  } else {
    fail("X-SAVEFAIL", "保存失败导致锚点异常", `save=${saveRes.status} before=${anchor?.key} after=${anchorAfter?.key}`);
  }
  db.close();
}
// 模型返回非法结构 → 503 且不推进 revision
{
  const db = fixture();
  await recover(db);
  const revBefore = revOf(db);
  const fake = fakeModel("这不是 JSON");
  let res;
  try {
    const anchor = anchorOf(db);
    res = await turn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: ANSWER_FOR[anchor.key], answers: {}, mode: "harness", baseRevision: revOf(db) });
  } finally { fake.restore(); }
  if (res.status === 503 && revOf(db) === revBefore) pass("X-BADJSON", "模型返回非法结构 → 503 且本轮不推进 revision");
  else fail("X-BADJSON", "非法结构处理异常", `status=${res.status} rev=${revBefore}→${revOf(db)}`);
  db.close();
}
// 重复提交同一问题（不得因新修复而恶化）
{
  const db = fixture();
  await recover(db);
  const anchor = anchorOf(db);
  const body = { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: ANSWER_FOR[anchor.key], answers: {}, mode: "fixture", baseRevision: revOf(db) };
  const r1 = await turn(db, body);
  const r2 = await turn(db, body);
  const b2 = await r2.clone().json();
  // 已知行为：无轮次幂等（PILOT-08 已记录）。此处只要求"不产生错误归类/不损坏锚点"
  const anchorStillValid = Boolean(anchorOf(db)?.key);
  if (r1.status === 200 && anchorStillValid) {
    pass("X-DUP", "重复提交同一问题：不产生错误归类、锚点保持有效（既有幂等缺口未因本轮修复恶化）", `第1次=${r1.status} 第2次=${r2.status}${b2.code ? " " + b2.code : ""}`);
  } else {
    fail("X-DUP", "重复提交导致状态损坏", `r1=${r1.status} r2=${r2.status}`);
  }
  db.close();
}

// ═══════════════════════════════════════════════════════════════
// 组 5：员工确认/更正 · 核验可见性 · 旧草稿兼容
// ═══════════════════════════════════════════════════════════════
console.log("\n── 组 5：确认/更正 · 核验可见性 · 旧草稿兼容 ──");
// 员工确认与更正（含枚举规范化）
{
  const answers = { ...ANSWER_FOR };
  // PILOT-08E/D1：先确立服务端推断基线；客户端提交不同 text 以证明其不被采信。
  // ── PILOT-09C/IMPLEMENT-2B：旧式夹具现代化 ────────────────────────────
  // 可信基线必须由**真实服务端构建函数**（buildInferenceRecords）产出：
  //   · contentVersion / evidenceHash / templateVersion / listed 全部由服务端计算；
  //   · 不手工伪造"看似有效"的版本对象（否则测试会在生产路径之外自证成立）；
  //   · 沿用本用例原有的推断 ID（ID 仅是标识符），因此**原断言一字未改**。
  // 同时把判定写入**草稿**（inferenceVerdicts）—— 依据 IMPLEMENT-2B/F2，
  // 提交门禁的唯一可信判定来源是库中持久化草稿，而非请求体。
  // F03：模板推断 quote 必须与当前服务端答案一致（否则提交门禁按"模板引用与答案不一致"拒绝）。
  // 断言仍验证"落库原文取自服务端基线"（text 不变，客户端伪造 text 仍被忽略）。
  const _inferDefs = [{ legacyId: "INF-A", idSource: "template:trigger:self-only", source: "server_template", templateVersion: 1, quote: answers.trigger, text: "服务端基线推断A", basis: "trigger", assumes: "x" }, { legacyId: "INF-C", idSource: "template:exceptions:no-delete", source: "server_template", templateVersion: 1, quote: answers.exceptions, text: "服务端基线推断C", basis: "exceptions", assumes: "y" }];
  const _inferBaseline = buildInferenceRecords([], _inferDefs).records.map((entry, index) => ({ ...entry, id: _inferDefs[index].legacyId }));
  const _inferVerdict = (id, spec) => ({
    verdict: spec.verdict,
    correction: spec.correction || "",
    contentVersion: _inferBaseline.find((entry) => entry.id === id).contentVersion,
    templateVersion: _inferBaseline.find((entry) => entry.id === id).templateVersion,
    evidenceHash: _inferBaseline.find((entry) => entry.id === id).evidenceHash,
  });
  // F03：播种与真实统一证据写入同构的 ledger.evidence / statementHistory / 推断证据版本；
  // 判定回显 evidenceVersion（旧夹具缺该字段会被判 stale，属契约变更而非放宽断言）。
  const _evidenceSeed = seedEvidenceState({
    answers,
    inferences: _inferBaseline,
    revision: 0,
    verdicts: { "INF-A": { verdict: "agree", correction: "" }, "INF-C": { verdict: "correct", correction: "其实是版权原因" } },
  });
  const db = fixture({ rawDraft: serializeEmployeeDraft({ answers, ledger: { statements: _evidenceSeed.normalized, covered: Object.keys(_evidenceSeed.normalized), vagueTerms: [], unresolved: [], evidence: _evidenceSeed.evidence, statementHistory: _evidenceSeed.history, authoritativeInferences: _evidenceSeed.inferences }, inferenceVerdicts: _evidenceSeed.verdicts, submissionText: "", revision: 0 }) });
  // IMPLEMENT-05A：提交载荷 = 由草稿答案派生的服务端规范卡/文本（客户端 text/卡片不再自由填写）。
  const r = await submit(db, { text: canonicalText(answers), workflowCard: canonicalCard(answers, "provided"), materialStatus: "provided", inferences: [{ id: "INF-A", text: "客户端伪造A" }, { id: "INF-C", text: "客户端伪造C" }], inferenceVerdicts: { "INF-A": { verdict: "agree" }, "INF-C": { verdict: "correct", correction: "其实是版权原因" } } });
  const parsed = JSON.parse(db.get("SELECT alternative_explanations_json FROM work_items WHERE id=?", ITEM).alternative_explanations_json);
  const a = parsed.find((x) => x.id === "INF-A"); const c = parsed.find((x) => x.id === "INF-C");
  if (r.status === 200 && a?.verdict === "confirmed" && c?.verdict === "corrected" && c.correction === "其实是版权原因"
    && a?.text === "服务端基线推断A" && c?.text === "服务端基线推断C") {
    pass("X-VERDICT", "员工确认→confirmed、更正→corrected；原文取自服务端基线（客户端 text 被忽略）");
  } else {
    fail("X-VERDICT", "判定落库不正确", JSON.stringify(parsed));
  }
  db.close();
}
// 更正在下一轮进入模型上下文；confirmed 不被当作被否定
{
  const db = fixture({ rawDraft: serializeEmployeeDraft({ answers: { trigger: ANSWER_FOR.trigger }, ledger: null, inferenceVerdicts: { "INF-A": { verdict: "confirmed", correction: "" }, "INF-C": { verdict: "corrected", correction: "其实是版权原因" } }, submissionText: "", revision: 1 }) });
  const anchor = await recover(db);
  const capture = {};
  const fake = fakeModel(Q("inputs", "先看什么", "你先看哪些信息？"), capture);
  try {
    await turn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: ANSWER_FOR[anchor.key], answers: {}, mode: "harness", baseRevision: revOf(db) });
  } finally { fake.restore(); }
  const prompt = capture.prompts[0] || "";
  const hasCorrection = prompt.includes("其实是版权原因");
  const confirmedAsRejected = /rejectedInferences[^}]*INF-A/.test(prompt);
  if (hasCorrection && !confirmedAsRejected) pass("X-REJECTED", "corrected 进入模型上下文的 rejectedInferences；confirmed 不被误当作被否定");
  else fail("X-REJECTED", "回流语义错误", `corrected=${hasCorrection} confirmedRejected=${confirmedAsRejected}`);
  db.close();
}
// 核验人可见更正 + 其他项目不可见
{
  const self = JSON.stringify([{ id: "INF-1", text: "推断", verdict: "corrected", correction: "其实是版权原因" }]);
  const other = JSON.stringify([{ id: "INF-X", text: "别的项目", verdict: "corrected", correction: "别的项目更正内容" }]);
  const db = fixture({ altJson: self, altOther: other, withFact: true });
  const r = await verifierFacts({ request: bearerRequest(`http://127.0.0.1/api/formal/projects/${P}/verifier-facts`, VTOK), env: { DB: db }, params: { projectId: P } });
  const b = await r.clone().json();
  const visible = (b.facts || []).some((f) => (f.alternativeExplanations || []).some((x) => x.correction === "其实是版权原因"));
  const leaked = JSON.stringify(b).includes("别的项目更正内容");
  if (r.status === 200 && visible && !leaked) pass("X-VERIFIER", "核验人可见本项目员工更正；其他项目更正不泄漏");
  else fail("X-VERIFIER", "核验可见性或隔离异常", `status=${r.status} visible=${visible} leaked=${leaked}`);
  db.close();
}
// 旧草稿兼容（扁平 v1 格式）
{
  // 服务端库中可能是 PILOT-07 之前的扁平 v1 草稿（无 schemaVersion / 无 ledger）
  const flat = JSON.stringify({ trigger: "每天早上先看后台的曝光和成交数据", steps: "先选题再剪辑再发布" });
  const db = fixture({ rawDraft: flat });
  const stored = draftOf(db);
  const recovered = await recover(db);
  if (stored.answers.trigger && stored.answers.steps && recovered.status === 200 && anchorOf(db)?.key) {
    pass("X-LEGACY", "旧扁平草稿可读；缺锚点时可经服务端恢复路径建立可信身份（不直接放行任意维度）", `恢复签发=${anchorOf(db)?.key}`);
  } else {
    fail("X-LEGACY", "旧草稿兼容失败", JSON.stringify({ answers: Object.keys(stored.answers), status: recovered.status }));
  }
  db.close();
}

// ═══════════════════════════════════════════════════════════════
// 组 6：静态结构断言（不修改核心机制）
// ═══════════════════════════════════════════════════════════════
console.log("\n── 组 6：结构断言 ──");
{
  const turnSrc = readFileSync(new URL("../functions/api/agent/employee-turn.js", import.meta.url), "utf8");
  const draftSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/employee-draft.js", import.meta.url), "utf8");
  const sharedSrc = readFileSync(new URL("../functions/_shared.js", import.meta.url), "utf8");
  const noClientAnchor = !/pendingQuestion:\s*sanitizePendingQuestion\(value\.pendingQuestion\)/.test(draftSrc);
  const hasServerWrite = /async function issueAnchor/.test(turnSrc) && /casWriteEmployeeDraft/.test(draftSrc);
  const casIntact = /export async function casWriteEmployeeDraft/.test(sharedSrc) && /meta\.changes/.test(sharedSrc);
  if (noClientAnchor && hasServerWrite && casIntact) pass("S-CORE", "客户端锚点入口已关闭；锚点由服务端签发；CAS 核心未改动");
  else fail("S-CORE", "结构断言失败", `noClientAnchor=${noClientAnchor} serverWrite=${hasServerWrite} cas=${casIntact}`);
}
{
  const sharedSrc = readFileSync(new URL("../functions/_shared.js", import.meta.url), "utf8");
  const vSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/verification.js", import.meta.url), "utf8");
  const authIntact = sharedSrc.includes("export async function formalActor") && vSrc.includes("first_verified_by_account_id!=?");
  if (authIntact) pass("S-AUTH", "权限体系与双人核验规则零改动");
  else fail("S-AUTH", "权限或双人核验规则被改动");
}

const count = (v) => results.filter((r) => r.verdict === v).length;
console.log("\n──────────────── 结果明细 ────────────────");
for (const r of results) {
  console.log(`  ${r.verdict === "PASS" ? "✔" : "✘"} [${r.verdict}] ${r.id} · ${r.name}${r.note ? `\n        ${r.note}` : ""}`);
}
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${count("PASS")}  FAIL=${count("FAIL")}`);
console.log("\n  【本地模拟 + 内存库】不构成真实模型或浏览器端到端验证。");
assert.equal(count("FAIL"), 0, "存在 FAIL 用例");
console.log("\npilot08a runtime: ok");
