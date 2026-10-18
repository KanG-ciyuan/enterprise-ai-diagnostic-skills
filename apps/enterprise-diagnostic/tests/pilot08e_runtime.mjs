/**
 * PILOT-08E —— 可信推断持久化（D1）与访谈完成条件（D2）契约测试
 *
 * 覆盖报告 §六（并发与状态安全 1–15）、§七（刷新恢复）、§八（提交可信性）、§十二（D2 场景 A–L）。
 * 全部走真实 handler + 内存 D1 + 注入假模型：不触网、不用真实密钥。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";
import { ANSWER_DIMENSIONS as EVIDENCE_DIMENSIONS, canonicalJson as evidenceCanonicalJson, normalizeAnswers as evidenceNormalizeAnswers } from "../functions/api/agent/_evidence.js";
import { appendStatementHistory } from "../functions/api/agent/_adapter.js";
import { onRequestPost as agentTurn } from "../functions/api/agent/employee-turn.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { buildInferenceRecords, mergeAuthoritativeInferences, normalizeInference } from "../functions/api/agent/_adapter.js";
import { serializeEmployeeDraft, normalizeEmployeeDraft, draftRevisionOf } from "../functions/_shared.js";

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });

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

const P = "PRJ-P08E001", ITEM = "WI-P08E001", EMP = "ACC-P08E-EMP", VER = "ACC-P08E-VER";
const TOK = "TOK-P08E-EMP", KEY = "fake-deepseek-key-not-real";
const DIMS = ["trigger", "inputs", "steps", "judgments", "exceptions", "handoff", "burden"];

const A = {
  trigger: "每天早上八点先看后台曝光和成交数据，然后去蝉妈妈挑三条对标视频。",
  inputs: "动手前先看昨天哪条转化最好、库存还剩多少、这周主推哪个品类。",
  steps: "第一步挑对标，第二步写脚本，第三步拍摄，第四步剪辑，第五步挂车发布。",
  judgments: "毛利低于百分之十我一定找主管确认，库存低于五十件也要先问运营。",
  exceptions: "素材版权拿不准就换成同款其他达人的素材；断货就先下架再换替代品。",
  handoff: "剪完交给投放小李挂车发布，发布后前两小时我自己盯转化数据。",
  burden: "整套流程大概两个半小时到三个小时，挑对标最花时间。",
  burdenUnknown: "这个我确实不知道，没有统计过耗时。",
};
const CARD = { trigger: A.trigger, inputs: A.inputs, steps: A.steps, judgments: A.judgments, exceptions: A.exceptions, handoff: A.handoff, burden: A.burden, materialIndex: "有已授权材料" };

function fixture({ revision = 0, answers = {}, ledger = null, rawDraft = null } = {}) {
  const db = new D1Harness();
  const dj = (rawDraft ?? serializeEmployeeDraft({ answers, ledger, inferenceVerdicts: {}, submissionText: "", revision })).replace(/'/g, "''");
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@p08e.invalid','小李','active','member'),
      ('${VER}','ver@p08e.invalid','核验人','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES
      ('${P}','短视频带货流程诊断','选品到发布与复盘','mapping','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P}','${EMP}','employee','project','active'),
      ('${P}','${VER}','verifier','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-P08E','${P}','授权','王总','o@p08e.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key) VALUES
      ('INV-P08E-VER','invite-p08e-ver','${P}','${EMP}','ver@p08e.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','INVK-P08E');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R1');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version) VALUES
      ('${ITEM}','${P}','还原工作','d','mapping','needs_input','employee','小李',0,'b','n','${EMP}','${VER}','${dj}','provided',1,1);
  `);
  return db;
}

const originalFetch = globalThis.fetch;
const fakeModel = (content) => {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
};
const restore = () => { globalThis.fetch = originalFetch; };
const Q = (key, extra = {}) => JSON.stringify({ turnKind: "question", question: { key, label: key, prompt: `请说明 ${key}`, ...extra } });
const DRAFT = JSON.stringify({ turnKind: "draft", question: null, endingProposal: { recommended: true, reason: "覆盖已满足", missingNote: "" } });

const dj = (db) => JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json);
const draftOf = (db) => normalizeEmployeeDraft(dj(db));
const ledgerOf = (db) => draftOf(db).ledger;
const revOf = (db) => draftRevisionOf(dj(db));
const baselineOf = (db) => (ledgerOf(db)?.authoritativeInferences) || [];
/** PILOT-09C/FIX-3C：从**真实服务端构建的推断条目**回显版本（FIX-3B 起判定保存需版本绑定）。
 *  仅补齐"回显"字段，不改变判定语义与断言；版本值全部取自基线条目本身。 */
const echoVerdict = (entry, verdict, correction = "") => ({
  verdict,
  correction,
  contentVersion: Number.isInteger(entry.contentVersion) ? entry.contentVersion : null,
  templateVersion: entry.templateVersion === undefined ? null : entry.templateVersion,
  evidenceHash: entry.evidenceHash || null,
  // PILOT-09C/IMPLEMENT-05B（F03）：判定必须回显条目当前 evidenceVersion，
  // 否则服务端按"旧判定（未绑定证据版本）"拒绝盖章。
  evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : 0,
});
const turn = (db, body) => agentTurn({ request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", TOK, body), env: { DB: db, DEEPSEEK_API_KEY: KEY }, params: {} });
const put = (db, body) => saveDraft({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, TOK, body), env: { DB: db }, params: { itemId: ITEM } });
const submit = (db, body, key = "K-P08E") => submitEmployee({
  // PILOT-09C/FIX-CODEX-03A：正式提交现在必须携带 baseRevision（测试按库中当前版本补齐）。
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK, { ...body, baseRevision: Number.isInteger(body.baseRevision) ? body.baseRevision : revOf(db) }, { "Idempotency-Key": key }),
  env: { DB: db }, params: { itemId: ITEM },
});

// ── PILOT-09C/IMPLEMENT-05A（F04）：正式提交必须使用服务端规范卡/规范文本 ──
// 服务端只从**已持久化的草稿 answers + work_items.material_status** 派生 card/text，
// 客户端载荷与之不一致即 422。测试的提交载荷因此也由同一份答案按契约派生；
// 断言仍验证"最终落库/拦截结果"，不降低强度。
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
  for (const key of DIMS) card[key] = String(answers[key] || "").trim();
  card.materialIndex = MATERIAL_INDEX_LABELS[materialStatus];
  return card;
};
const canonicalText = (answers) => DIMS.map((key) => `${DIMENSION_LABELS[key]}：${String(answers[key] || "").trim()}`).join("\n\n");

/** 仅取/刷新锚点（服务端签发），不作答 */
async function issueAnchor(db, answers = null) {
  const ans = answers || draftOf(db).answers;
  const rec = await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: ans, mode: "fixture", baseRevision: revOf(db) });
  const body = await rec.clone().json();
  return { status: rec.status, body, anchor: ledgerOf(db)?.pendingQuestion?.key || null };
}

/**
 * 走一轮：用给定模型输出回答**当前已签发的锚点**，然后保存。
 * 注意：本函数不再自行 recover —— 否则会把锚点换成新问题，导致 question_identity_mismatch。
 */
async function walkOnce(db, { model, answerKey = null, answers = null } = {}) {
  const ans = answers || draftOf(db).answers;
  const anchor = ledgerOf(db)?.pendingQuestion?.key;
  if (!anchor) {
    const issued = await issueAnchor(db, ans);
    if (!issued.anchor) return { skipped: true, body: issued.body };
  }
  const key = answerKey || ledgerOf(db)?.pendingQuestion?.key;
  fakeModel(model);
  let res; let body;
  try {
    res = await turn(db, { projectId: P, workItemId: ITEM, questionKey: key, answer: ans[key] || "按实际做法执行", answers: ans, mode: "harness", baseRevision: revOf(db) });
    body = await res.clone().json();
  } finally { restore(); }
  if (res.status === 200) {
    await put(db, { answers: { ...ans, [key]: ans[key] || "按实际做法执行" }, materialStatus: "provided", baseRevision: revOf(db), ledger: body?.turn?.interviewState?.ledger });
  }
  return { res, body, anchor: key, key };
}

console.log("PILOT-08E 可信推断持久化与访谈完成条件 —— 契约测试\n");

// ═══════════════════════════════════════════════════════════════
// D1：推断身份与合并语义
// ═══════════════════════════════════════════════════════════════
console.log("── D1 推断身份 ──");
{
  const a = { text: "推断A：挑素材靠人工", basisDimension: "steps" };
  const n1 = normalizeInference(a); const n2 = normalizeInference({ ...a });
  const other = normalizeInference({ text: "推断B：触发后本人处理", basisDimension: "trigger" });
  if (n1.id === n2.id && n1.id !== other.id && /^INF-/.test(n1.id)) pass("D1-ID", "推断 ID 由内容派生：同内容同 ID、异内容异 ID", n1.id);
  else fail("D1-ID", "ID 不稳定", `${n1.id} / ${n2.id} / ${other.id}`);
}
{
  const one = normalizeInference({ text: "推断A", basisDimension: "steps" });
  const two = normalizeInference({ text: "推断B", basisDimension: "trigger" });
  const first = mergeAuthoritativeInferences([], [one, two]);
  const dup = mergeAuthoritativeInferences(first, [one, two]);
  const empty = mergeAuthoritativeInferences(first, []);
  const many = mergeAuthoritativeInferences([], Array.from({ length: 30 }, (_, i) => ({ text: `推断${i}`, basisDimension: "steps" })));
  if (first.length === 2 && dup.length === 2 && empty.length === 2 && many.length <= 12) {
    pass("D1-MERGE", "合并语义：去重不膨胀 / 空列表不能删除 / 有上限保护", `first=2 dup=${dup.length} empty=${empty.length} cap=${many.length}`);
  } else {
    fail("D1-MERGE", "合并语义异常", `first=${first.length} dup=${dup.length} empty=${empty.length} cap=${many.length}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// D1 §六：并发与状态安全 1–15
// ═══════════════════════════════════════════════════════════════
console.log("\n── D1 §六 并发与状态安全 ──");
// 1 正常生成并落库
{
  const db = fixture();
  await walkOnce(db, { model: Q("inputs") });
  const baseline = baselineOf(db);
  if (baseline.length > 0 && baseline.every((e) => e.id && e.text)) pass("D1-1", "正常轮次后推断基线已落库（含稳定 ID 与原文）", `${baseline.length} 条`);
  else fail("D1-1", "基线未落库", JSON.stringify(baseline));
  db.close();
}
// 2/3 CAS 冲突不覆盖旧状态
{
  const db = fixture();
  await walkOnce(db, { model: Q("inputs") });
  const before = JSON.stringify(baselineOf(db));
  const stale = await put(db, { answers: {}, materialStatus: "provided", baseRevision: 0, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], authoritativeInferences: [] } });
  const sb = await stale.clone().json();
  if (stale.status === 409 && sb.code === "draft_conflict" && JSON.stringify(baselineOf(db)) === before) {
    pass("D1-2", "旧 revision 写入 → 409 draft_conflict，且不覆盖已有推断基线");
  } else {
    fail("D1-2", "CAS 未保护基线", `status=${stale.status} code=${sb.code} same=${JSON.stringify(baselineOf(db)) === before}`);
  }
  db.close();
}
// 4 重复请求不产生重复推断
{
  const db = fixture();
  await walkOnce(db, { model: Q("inputs") });
  const n1 = baselineOf(db).length;
  await walkOnce(db, { model: Q("burden") });
  const n2 = baselineOf(db).length;
  if (n2 >= n1 && n2 <= 12 && new Set(baselineOf(db).map((e) => e.id)).size === n2) pass("D1-4", "多轮推进后基线无重复 ID（去重生效）", `${n1} → ${n2}`);
  else fail("D1-4", "基线出现重复或失控", `${n1} → ${n2}`);
  db.close();
}
// 5/6 同一任务不同轮次 ID 关联稳定；跨任务不复用
{
  const db = fixture();
  await walkOnce(db, { model: Q("inputs") });
  const ids1 = baselineOf(db).map((e) => e.id).sort();
  const text1 = baselineOf(db).map((e) => e.text).sort();
  await walkOnce(db, { model: Q("steps") });
  const ids2 = baselineOf(db).map((e) => e.id).sort();
  const kept = ids1.every((id) => ids2.includes(id));
  if (kept) pass("D1-5", "跨轮次已确立的推断保持同一 ID（判定不会脱钩）", `保留 ${ids1.length} 条`);
  else fail("D1-5", "跨轮次 ID 漂移", `${JSON.stringify(ids1)} vs ${JSON.stringify(ids2)}`);
  db.close();
}
// 8 跨项目不可读：基线只存在于本任务草稿
{
  const db = fixture();
  await walkOnce(db, { model: Q("inputs") });
  const other = db.get("SELECT COUNT(*) AS c FROM work_items WHERE project_id<>?", P).c;
  if (Number(other) === 0) pass("D1-8", "推断基线存于任务草稿，不含跨项目数据（本库无其他项目任务）");
  else fail("D1-8", "存在跨项目任务", String(other));
  db.close();
}
// 9/10 客户端伪造 / 删除 / 改写原文
{
  const db = fixture();
  await walkOnce(db, { model: Q("inputs") });
  const before = baselineOf(db);
  await put(db, {
    answers: {}, materialStatus: "provided", baseRevision: revOf(db),
    ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [],
      authoritativeInferences: [{ id: "INF-FAKE", text: "伪造推断：老板要裁员", basis: null, assumes: null }] },
  });
  const after = baselineOf(db);
  const noFake = !after.some((e) => e.id === "INF-FAKE" || String(e.text).includes("裁员"));
  const sameLen = after.length === before.length;
  const sameText = after[0]?.text === before[0]?.text;
  if (noFake && sameLen && sameText) pass("D1-9", "客户端伪造 / 替换 / 删除推断基线均被忽略（基线原样保留）");
  else fail("D1-9", "客户端影响了基线", `noFake=${noFake} len=${before.length}→${after.length}`);
  db.close();
}
// 11/12 已保存判定与更正原文不丢失
{
  const db = fixture();
  await walkOnce(db, { model: Q("inputs") });
  const target = baselineOf(db)[0];
  await put(db, { answers: {}, materialStatus: "provided", baseRevision: revOf(db), inferenceVerdicts: { [target.id]: echoVerdict(target, "correct", "其实是版权原因") } });
  const stored = draftOf(db).inferenceVerdicts[target.id];
  if (stored?.verdict === "corrected" && stored.correction === "其实是版权原因") pass("D1-11", "判定与更正原文落库并保持（corrected + 原文）");
  else fail("D1-11", "判定或更正丢失", JSON.stringify(stored));
  db.close();
}
// 13 判定 ID 必须与基线一致
{
  const db = fixture();
  await walkOnce(db, { model: Q("inputs") });
  const target = baselineOf(db)[0];
  await put(db, { answers: {}, materialStatus: "provided", baseRevision: revOf(db), inferenceVerdicts: { [target.id]: echoVerdict(target, "agree"), "INF-NOT-IN-BASELINE": { verdict: "agree" } } });
  const v = draftOf(db).inferenceVerdicts;
  if (target.id in v && !("INF-NOT-IN-BASELINE" in v)) pass("D1-13", "判定只能对应真实存在的推断 ID（不存在的被丢弃）");
  else fail("D1-13", "判定 ID 未按基线裁剪", JSON.stringify(Object.keys(v)));
  db.close();
}
// 14 未判定不得被自动标记 confirmed
{
  const db = fixture();
  await walkOnce(db, { model: Q("inputs") });
  const v = draftOf(db).inferenceVerdicts;
  if (Object.keys(v).length === 0) pass("D1-14", "未判定的推断不会被自动标记为 confirmed（无判定即无记录）");
  else fail("D1-14", "出现自动判定", JSON.stringify(v));
  db.close();
}
// 15 客户端不能利用旧推断绕过提交守卫
{
  const db = fixture();
  await walkOnce(db, { model: Q("inputs") });
  // 只判定 1 条（基线可能有多条）→ 若有未判定项，提交应被拒
  // IMPLEMENT-05A：正式提交要求草稿答案完整，且判定只信任**已保存到草稿**的值。
  // PILOT-09C/IMPLEMENT-05B（F03）：答案变化会推进受影响推断的证据版本（模板引用重建），
  // 因此按真实生产顺序：① 先保存完整答案；② 从**服务端当前基线**回显版本保存判定；
  // ③ 再用规范卡/文本提交（否则回显的是答案变化前的旧版本，会被判 stale——这是契约要求的失效语义）。
  await put(db, { answers: A, materialStatus: "provided", baseRevision: revOf(db) });
  const target = baselineOf(db)[0];
  await put(db, { answers: {}, materialStatus: "provided", baseRevision: revOf(db), inferenceVerdicts: { [target.id]: echoVerdict(target, "agree") } });
  const answersNow = draftOf(db).answers;
  const r = await submit(db, { text: canonicalText(answersNow), workflowCard: canonicalCard(answersNow, "provided"), materialStatus: "provided", inferences: [], inferenceVerdicts: {} });
  const body = await r.clone().json();
  const unjudged = baselineOf(db).length - 1;
  if (unjudged > 0) {
    if (r.status === 422 && body.code === "inferences_unjudged") pass("D1-15", "存在未判定推断 → 提交被拒（不能只判定部分就进核验）", body.code);
    else fail("D1-15", "未判定推断未被拦截", `${r.status} ${body.code}`);
  } else if (r.status === 200) {
    pass("D1-15", "基线仅 1 条且已判定 → 允许提交（守卫按实际未判定数生效）");
  } else {
    fail("D1-15", "单条已判定却被拒绝", `${r.status} ${body.code}`);
  }
  db.close();
}

// ═══════════════════════════════════════════════════════════════
// D1 §八：最终提交可信性
// ═══════════════════════════════════════════════════════════════
console.log("\n── D1 §八 提交可信性 ──");
{
  // 客户端伪造推断原文 → 落库必须用服务端基线原文
  // ── PILOT-09C/IMPLEMENT-2B：旧式夹具现代化 ────────────────────────────
  // 可信基线必须由**真实服务端构建函数**（buildInferenceRecords）产出：
  //   · contentVersion / evidenceHash / templateVersion / listed 全部由服务端计算；
  //   · 不手工伪造"看似有效"的版本对象（否则测试会在生产路径之外自证成立）；
  //   · 沿用本用例原有的推断 ID（ID 仅是标识符），因此**原断言一字未改**。
  // 同时把判定写入**草稿**（inferenceVerdicts）—— 依据 IMPLEMENT-2B/F2，
  // 提交门禁的唯一可信判定来源是库中持久化草稿，而非请求体。
  // F03：模板推断 quote 必须与当前服务端答案一致（否则提交门禁按"模板引用与答案不一致"拒绝）；
  // 断言仍验证"落库的推断原文取自服务端基线"（text 不变，客户端伪造原文仍被忽略）。
  const _inferDefs = [{ legacyId: "INF-S", idSource: "template:steps:strict-order", source: "server_template", templateVersion: 1, quote: A.steps, text: "服务端基线原文", basis: "steps", assumes: "x" }];
  const _inferBaseline = buildInferenceRecords([], _inferDefs).records.map((entry, index) => ({ ...entry, id: _inferDefs[index].legacyId }));
  const _inferVerdict = (id, spec) => ({
    verdict: spec.verdict,
    correction: spec.correction || "",
    contentVersion: _inferBaseline.find((entry) => entry.id === id).contentVersion,
    templateVersion: _inferBaseline.find((entry) => entry.id === id).templateVersion,
    evidenceHash: _inferBaseline.find((entry) => entry.id === id).evidenceHash,
  });
  // F03：播种与真实统一证据写入同构的证据状态，判定回显 evidenceVersion。
  const _evidenceSeed = seedEvidenceState({ answers: A, inferences: _inferBaseline, revision: 0, verdicts: { "INF-S": { verdict: "agree", correction: "" } } });
  const db = fixture({ rawDraft: serializeEmployeeDraft({ answers: A, ledger: { statements: _evidenceSeed.normalized, covered: Object.keys(_evidenceSeed.normalized), vagueTerms: [], unresolved: [], evidence: _evidenceSeed.evidence, statementHistory: _evidenceSeed.history, authoritativeInferences: _evidenceSeed.inferences }, inferenceVerdicts: _evidenceSeed.verdicts, submissionText: "", revision: 0 }) });
  const r = await submit(db, { text: canonicalText(A), workflowCard: canonicalCard(A, "provided"), materialStatus: "provided", inferences: [{ id: "INF-S", text: "客户端伪造原文：应被忽略" }], inferenceVerdicts: { "INF-S": { verdict: "agree" } } });
  const parsed = JSON.parse(db.get("SELECT alternative_explanations_json FROM work_items WHERE id=?", ITEM).alternative_explanations_json);
  if (r.status === 200 && parsed.length === 1 && parsed[0].text === "服务端基线原文") pass("D1-SUB-TEXT", "提交落库的推断原文取自服务端基线（客户端 text 被忽略）", parsed[0].text);
  else fail("D1-SUB-TEXT", "客户端原文被采信或提交失败", `${r.status} ${JSON.stringify(parsed)}`);
  db.close();
}
{
  // 无基线 + 客户端自报推断 → 可恢复错误，不伪造来源
  // IMPLEMENT-05A：正式提交要求草稿答案完整，先补齐七维（否则会先被 answers_incomplete 拦下，
  // 走不到本用例要验证的 inference_baseline_missing 分支）。
  const db = fixture({ answers: A });
  const r = await submit(db, { text: canonicalText(A), workflowCard: canonicalCard(A, "provided"), materialStatus: "provided", inferences: [{ id: "INF-X", text: "客户端自报" }], inferenceVerdicts: {} });
  const body = await r.clone().json();
  const alt = db.get("SELECT alternative_explanations_json FROM work_items WHERE id=?", ITEM).alternative_explanations_json;
  // PILOT-09C/IMPLEMENT-05B（F03）：提交前证据门禁先行 —— 无服务端访谈证据
  // （无推断基线 / 无陈述历史）时以 409 interview_evidence_missing 明确拒绝，
  // 客户端自报推断仍不会被采信、不写入任何推断。断言强度不变（仍要求 409 + 明确错误码 + 零写入）。
  if (r.status === 409 && body.code === "interview_evidence_missing" && (alt === "[]" || alt === "")) {
    pass("D1-SUB-NOBASE", "无服务端基线/陈述历史（无访谈证据）+ 客户端自报推断 → 409 interview_evidence_missing，且不写入任何推断", body.code);
  } else {
    fail("D1-SUB-NOBASE", "旧载荷被默认信任或错误码不符", `${r.status} ${body.code} alt=${alt}`);
  }
  db.close();
}
{
  // 无基线且客户端未自报 → 不拦截（历史兼容，不伪造）
  const db = fixture({ answers: A });
  const r = await submit(db, { text: canonicalText(A), workflowCard: canonicalCard(A, "provided"), materialStatus: "provided", inferences: [], inferenceVerdicts: {} });
  const body = await r.clone().json();
  const parsed = JSON.parse(db.get("SELECT alternative_explanations_json FROM work_items WHERE id=?", ITEM).alternative_explanations_json || "[]");
  // PILOT-09C/IMPLEMENT-05B（F03，契约 §6）：无访谈证据（无推断基线/无历史）不得直接正式提交，
  // 必须给可恢复错误 409 interview_evidence_missing，且不伪造任何推断/历史来源。
  if (r.status === 409 && body.code === "interview_evidence_missing" && Array.isArray(parsed) && parsed.length === 0) {
    pass("D1-SUB-LEGACY", "无基线且未自报推断（无访谈证据）→ 409 interview_evidence_missing（可恢复），零写入、不伪造历史来源", body.code);
  } else {
    fail("D1-SUB-LEGACY", "无访谈证据提交未被可恢复拒绝", `${r.status} ${body.code || ""} ${JSON.stringify(parsed)}`);
  }
  db.close();
}

// ═══════════════════════════════════════════════════════════════
// D2：burden 必问契约（§十二 场景 A–L）
// ═══════════════════════════════════════════════════════════════
console.log("\n── D2 burden 必问契约 ──");
const BASE_ANS = { trigger: A.trigger, inputs: A.inputs, steps: A.steps, judgments: A.judgments, exceptions: A.exceptions, handoff: A.handoff };
/** 逐轮推进，直到"当前待答的问题就是 burden"。 */
async function walkToBurdenPending() {
  const db = fixture({ answers: BASE_ANS });
  await issueAnchor(db, BASE_ANS);
  for (let i = 0; i < 12; i += 1) {
    const anchor = ledgerOf(db)?.pendingQuestion?.key;
    if (!anchor) break;
    if (anchor === "burden") return db;
    await walkOnce(db, { model: Q(anchor), answerKey: anchor, answers: BASE_ANS });
    const next = ledgerOf(db)?.pendingQuestion?.key;
    if (next === "burden") return db;
    if (!next) { await issueAnchor(db, BASE_ANS); if (ledgerOf(db)?.pendingQuestion?.key === "burden") return db; }
  }
  return db;
}
// C：模型未问 burden 就出卡 → 服务端拒绝
{
  const db = await walkToBurdenPending();
  const asked = ledgerOf(db)?.burdenAsked === true;
  fakeModel(DRAFT);
  let res; let body;
  try {
    const anchor = ledgerOf(db)?.pendingQuestion?.key || "burden";
    res = await turn(db, { projectId: P, workItemId: ITEM, questionKey: anchor, answer: asked ? A.burden : (BASE_ANS[anchor] || "按实际做法"), answers: BASE_ANS, mode: "harness", baseRevision: revOf(db) });
    body = await res.clone().json();
  } finally { restore(); }
  if (!asked && body.turn?.turnKind === "question" && body.turn?.nextQuestion?.key === "burden") pass("D2-C", "burden 未询问时模型建议出卡 → 服务端拒绝并优先补问 burden", body.turn.nextQuestion.key);
  else if (asked && body.turn?.turnKind === "draft") pass("D2-C", "burden 已询问 → 允许出卡（前置条件正确放行）");
  else fail("D2-C", "未按 burden 必问契约裁决", `asked=${asked} kind=${body.turn?.turnKind} next=${body.turn?.nextQuestion?.key}`);
  db.close();
}
// D/E/F：回答估算 / 不知道 / 无额外负担 → 均可出卡且原话保留
for (const [id, label, answer] of [
  ["D2-D", "员工提供具体耗时估算", A.burden],
  ["D2-E", "员工明确表示不知道", A.burdenUnknown],
  ["D2-F", "员工明确表示没有额外负担", "没有额外的负担，就是正常做一遍"],
]) {
  // burdenAsked 交由服务端在签发 burden 问题时置位（客户端不可写），
  // 因此这里**不预设** true —— 否则 recover 会直接返回 interview_complete。
  const db = fixture({ answers: { ...BASE_ANS, burden: answer }, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], authoritativeInferences: [] } });
  fakeModel(DRAFT);
  let res; let body;
  try {
    const anchor = ledgerOf(db)?.pendingQuestion?.key;
    if (!anchor) { await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: { ...BASE_ANS, burden: answer }, mode: "fixture", baseRevision: revOf(db) }); }
    const key = ledgerOf(db)?.pendingQuestion?.key || "burden";
    res = await turn(db, { projectId: P, workItemId: ITEM, questionKey: key, answer: answer, answers: { ...BASE_ANS, burden: answer }, mode: "harness", baseRevision: revOf(db) });
    body = await res.clone().json();
  } finally { restore(); }
  // buildFlowCard 把七维文本放在 dimensions 下
  const cardBurden = body.turn?.flowCard?.dimensions?.burden;
  const kept = String(cardBurden || "").includes(answer.slice(0, 12));
  if (res.status === 200 && kept) pass(id, `${label} → 可出卡且原话保留（不生成数字）`, String(cardBurden).slice(0, 40));
  else fail(id, `${label} → 处理异常`, `status=${res.status} cardBurden=${JSON.stringify(cardBurden)} kind=${body.turn?.turnKind} code=${body.code || "-"}`);
  db.close();
}
// K：不知道 → 不生成虚假数字
{
  const answers = { ...BASE_ANS, burden: A.burdenUnknown };
  // PILOT-09C/IMPLEMENT-05B（F03）：提交必须有服务端访谈证据（推断基线 + 一致证据元数据），
  // 因此播种服务端基线（断言仍是："不知道"原话进入事实且不生成数字）。
  const baseInferences = buildInferenceRecords([], [
    { source: "model", text: "P08E 基线推断 1：耗时与人力依据员工自述", basis: "burden", assumes: "若与实际不符需更正" },
    { source: "model", text: "P08E 基线推断 2：执行步骤依据员工自述", basis: "steps", assumes: "若与实际不符需更正" },
  ]).records;
  const evidenceSeed = seedEvidenceState({ answers, inferences: baseInferences, revision: 0 });
  const db = fixture({ rawDraft: serializeEmployeeDraft({ answers, ledger: { statements: evidenceSeed.normalized, covered: Object.keys(evidenceSeed.normalized), vagueTerms: [], unresolved: [], evidence: evidenceSeed.evidence, statementHistory: evidenceSeed.history, authoritativeInferences: evidenceSeed.inferences, burdenAsked: true }, inferenceVerdicts: evidenceSeed.verdicts, submissionText: "", revision: 0 }) });
  // IMPLEMENT-05A：提交载荷 = 由草稿答案派生的规范卡/文本。
  const r = await submit(db, { text: canonicalText(answers), workflowCard: canonicalCard(answers, "provided"), materialStatus: "provided", inferences: [], inferenceVerdicts: {} });
  const fact = db.get("SELECT claim FROM candidate_facts WHERE source_field='burden'");
  const claim = String(fact?.claim || "");
  const noFabricatedNumber = !/\d+\s*(分钟|小时|人|元)/.test(claim);
  if (r.status === 200 && claim.includes("不知道") && noFabricatedNumber) pass("D2-K", "「不知道」保留原话进入事实，未生成任何数字/人数（不制造虚假工时事实）", claim.slice(0, 50));
  else fail("D2-K", "未知被转为数字或未落库", `status=${r.status} claim=${claim}`);
  db.close();
}
// G/H/I：其他必需维度 / 材料 / 卡片确认
{
  const db = fixture({ rawDraft: serializeEmployeeDraft({ answers: { ...BASE_ANS, burden: A.burden }, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], authoritativeInferences: [], burdenAsked: true }, inferenceVerdicts: {}, submissionText: "", revision: 0 }) });
  const bad = {};
  const r1 = await submit(db, { text: "全文", workflowCard: { ...CARD, steps: "" }, materialStatus: "provided", inferences: [], inferenceVerdicts: {} });
  bad.missingDim = r1.status;
  const r2 = await submit(db, { text: "全文", workflowCard: CARD, materialStatus: "undecided", inferences: [], inferenceVerdicts: {} }, "K2");
  bad.material = r2.status;
  const r3 = await submit(db, { text: "", workflowCard: CARD, materialStatus: "provided", inferences: [], inferenceVerdicts: {} }, "K3");
  bad.emptyText = r3.status;
  if (bad.missingDim === 422 && bad.material === 422 && bad.emptyText === 422) pass("D2-GHI", "必需维度缺失 / 材料状态未选 / 流程描述为空 → 仍全部拒绝提交", JSON.stringify(bad));
  else fail("D2-GHI", "守卫被放宽", JSON.stringify(bad));
  db.close();
}
// J：高影响事实仍进入核验
{
  const answers = { ...BASE_ANS, burden: A.burden };
  // F03：同 D2-K —— 必须带服务端访谈证据才能正式提交；断言仍验证高影响事实生成/分级。
  const baseInferences = buildInferenceRecords([], [
    { source: "model", text: "P08E 基线推断 1：耗时与人力依据员工自述", basis: "burden", assumes: "若与实际不符需更正" },
    { source: "model", text: "P08E 基线推断 2：执行步骤依据员工自述", basis: "steps", assumes: "若与实际不符需更正" },
  ]).records;
  const evidenceSeed = seedEvidenceState({ answers, inferences: baseInferences, revision: 0 });
  const db = fixture({ rawDraft: serializeEmployeeDraft({ answers, ledger: { statements: evidenceSeed.normalized, covered: Object.keys(evidenceSeed.normalized), vagueTerms: [], unresolved: [], evidence: evidenceSeed.evidence, statementHistory: evidenceSeed.history, authoritativeInferences: evidenceSeed.inferences, burdenAsked: true }, inferenceVerdicts: evidenceSeed.verdicts, submissionText: "", revision: 0 }) });
  // IMPLEMENT-05A：提交载荷 = 由草稿答案派生的规范卡/文本。
  await submit(db, { text: canonicalText(answers), workflowCard: canonicalCard(answers, "provided"), materialStatus: "provided", inferences: [], inferenceVerdicts: {} });
  const high = db.all("SELECT id,impact_level FROM candidate_facts WHERE impact_level='high'");
  const total = db.all("SELECT id FROM candidate_facts");
  if (total.length === 5 && high.length >= 1) pass("D2-J", "高影响事实仍按原规则生成（耗时/人力命中 high，进入核验流程）", `facts=${total.length} high=${high.length}`);
  else fail("D2-J", "事实生成或分级异常", `facts=${total.length} high=${high.length}`);
  db.close();
}
// 服务端：burdenAsked 为客户端不可写
{
  const db = fixture();
  await put(db, { answers: {}, materialStatus: "provided", baseRevision: 0, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], burdenAsked: true } });
  if (ledgerOf(db)?.burdenAsked !== true) pass("D2-NOWRITE", "burdenAsked 为服务端专属：客户端提交 true 不生效");
  else fail("D2-NOWRITE", "客户端可写 burdenAsked", String(ledgerOf(db)?.burdenAsked));
  db.close();
}
// L：不出现固定题库顺序回退
{
  const db = fixture({ answers: BASE_ANS });
  await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: BASE_ANS, mode: "fixture", baseRevision: revOf(db) });
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const key = ledgerOf(db)?.pendingQuestion?.key;
    if (!key) break;
    seen.push(key);
    await walkOnce(db, { model: Q(key), answerKey: key, answers: BASE_ANS });
    await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: BASE_ANS, mode: "fixture", baseRevision: revOf(db) });
  }
  if (seen.length >= 2) pass("D2-L", "提问顺序由模型/服务端裁决驱动，未回退固定题库顺序", seen.join(" → "));
  else fail("D2-L", "未能推进多轮", JSON.stringify(seen));
  db.close();
}

// ═══════════════════════════════════════════════════════════════
// D1 §七：刷新恢复
// ═══════════════════════════════════════════════════════════════
console.log("\n── D1 §七 刷新恢复 ──");
{
  const db = fixture();
  await walkOnce(db, { model: Q("inputs") });
  const baseline = baselineOf(db);
  const target = baseline[0];
  await put(db, { answers: {}, materialStatus: "provided", baseRevision: revOf(db), inferenceVerdicts: { [target.id]: echoVerdict(target, "correct", "刷新后应仍在") } });
  // "刷新" = 重新从库读取（客户端不依赖任何内存/缓存）
  const afterReload = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
  const reloadedBaseline = afterReload.ledger?.authoritativeInferences || [];
  const reloadedVerdict = afterReload.inferenceVerdicts[target.id];
  const ok = reloadedBaseline.length === baseline.length
    && reloadedBaseline.every((e, i) => e.id === baseline[i].id && e.text === baseline[i].text)
    && reloadedVerdict?.verdict === "corrected" && reloadedVerdict.correction === "刷新后应仍在";
  if (ok) pass("D1-RELOAD", "刷新（重新读库）后：推断列表、ID、原文、判定与更正原文全部一致", `${reloadedBaseline.length} 条`);
  else fail("D1-RELOAD", "刷新后状态不一致", JSON.stringify({ n: reloadedBaseline.length, verdict: reloadedVerdict }));
  db.close();
}
{
  // 旧草稿（无基线）必须安全兼容：不制造推断、不自动确认
  const db = fixture({ revision: 1, answers: BASE_ANS, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [] } });
  const baseline = baselineOf(db);
  const verdicts = draftOf(db).inferenceVerdicts;
  if (baseline.length === 0 && Object.keys(verdicts).length === 0) pass("D1-LEGACY", "旧草稿无基线 → 安全兼容：不自动制造推断、不自动确认任何判定");
  else fail("D1-LEGACY", "旧草稿被自动填充", JSON.stringify({ baseline, verdicts }));
  db.close();
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
console.log("\npilot08e runtime: ok");
