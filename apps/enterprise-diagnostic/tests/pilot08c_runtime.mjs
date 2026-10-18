/**
 * PILOT-08C —— 定点修复的契约与回归测试
 *
 * 覆盖：
 *   R1 模型输出协议契约（prompt 声明字段 == 解析器读取字段）
 *   R2 锚点身份问题的受控恢复（可恢复 vs 必须拒绝）
 *   R3 推断判定判定持久化（客户端自动保存路径的行为契约）
 *   R4/R5 由 pilot04c_runtime 覆盖，本文件做交叉引用断言
 *
 * 所有模型行为通过注入假 fetch 模拟：不触网、不用真实密钥。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";
import { onRequestPost as agentTurn } from "../functions/api/agent/employee-turn.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { runHarness } from "../functions/api/agent/_adapter.js";
import { normalizeEmployeeDraft, serializeEmployeeDraft, draftRevisionOf } from "../functions/_shared.js";

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });

const P = "PRJ-P08C001", ITEM = "WI-P08C001", EMP = "ACC-P08C-EMP", VER = "ACC-P08C-VER";
const TOK = "TOK-P08C-EMP", VTOK = "TOK-P08C-VER";
const KEY = "fake-deepseek-key-not-real";
const DIMS = ["trigger", "inputs", "steps", "judgments", "exceptions", "handoff", "burden"];

const ADAPTER_SRC = readFileSync(new URL("../functions/api/agent/_adapter.js", import.meta.url), "utf8");
const APP_SRC = readFileSync(new URL("../app.js", import.meta.url), "utf8");

const ANSWER_FOR = {
  trigger: "每天早上先看后台的曝光和成交数据",
  inputs: "看曝光点击成交和退款率",
  steps: "先从蝉妈妈挑对标视频，然后写脚本拍摄，最后剪辑挂车发布",
  judgments: "毛利低于一成必须找主管确认",
  exceptions: "素材版权拿不准就换同款",
  handoff: "剪完交给投放小李挂车",
  burden: "一条大概三个小时",
};

function fixture({ revision = 0, answers = {}, ledger = null } = {}) {
  const db = new D1Harness();
  const dj = serializeEmployeeDraft({ answers, ledger, inferenceVerdicts: {}, submissionText: "", revision }).replace(/'/g, "''");
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@p08c.invalid','小李','active','member'),
      ('${VER}','ver@p08c.invalid','核验人','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES
      ('${P}','短视频带货流程诊断','选品到发布与复盘','mapping','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P}','${EMP}','employee','project','active'),
      ('${P}','${VER}','verifier','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-P08C','${P}','授权','王总','o@p08c.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key) VALUES
      ('INV-P08C-VER','invite-p08c-ver','${P}','${EMP}','ver@p08c.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','INVK-P08C');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R1'),
      ('${VTOK}','${VER}','${P}','2099-01-01T00:00:00Z','R2');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version) VALUES
      ('${ITEM}','${P}','还原工作','d','mapping','needs_input','employee','小李',0,'b','n','${EMP}','${VER}','${dj}','provided',1,1);
  `);
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

const draftJson = (db) => JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json);
const draftOf = (db) => normalizeEmployeeDraft(draftJson(db));
const anchorOf = (db) => draftOf(db).ledger?.pendingQuestion ?? null;
const revOf = (db) => draftRevisionOf(draftJson(db));
const turn = (db, body, token = TOK) =>
  agentTurn({ request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", token, body), env: { DB: db, DEEPSEEK_API_KEY: KEY }, params: {} });
const put = (db, body, token = TOK) =>
  saveDraft({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, token, body), env: { DB: db }, params: { itemId: ITEM } });

console.log("PILOT-08C 定点修复契约测试\n");

// ═══════════════════════════════════════════════════════════════
// R1：模型输出协议契约
// ═══════════════════════════════════════════════════════════════
console.log("── R1 模型输出协议契约 ──");
{
  // ① prompt 声明的字段名必须与解析器读取的字段名一致
  const declared = ADAPTER_SRC.match(/\{"turnKind":"question"\|"draft",'\s*\+\s*\n\s*'"?([A-Za-z]+)"?:\{/);
  const declaredField = declared ? declared[1] : (/"([A-Za-z]+)":\{"key":"<七维之一或追问标识>"/.exec(ADAPTER_SRC)?.[1] ?? null);
  const parserReads = /const q = parsed\.([A-Za-z]+) \|\| \{\}/.exec(ADAPTER_SRC)?.[1] ?? null;
  if (declaredField === "question" && parserReads === "question") {
    pass("R1-CONTRACT", "prompt 声明字段 == 解析器读取字段（统一为 question）", `declared=${declaredField} parsed=${parserReads}`);
  } else {
    fail("R1-CONTRACT", "prompt 与解析器字段名不一致", `declared=${declaredField} parsed=${parserReads}`);
  }
}
{
  // ② prompt 不得再声明 nextQuestion 作为模型 wire 字段
  const declaresNextQuestion = /"nextQuestion":\{"key":"<七维之一或追问标识>"/.test(ADAPTER_SRC);
  if (!declaresNextQuestion) pass("R1-NODRIFT", "prompt 中不再把 nextQuestion 声明为模型 wire 字段");
  else fail("R1-NODRIFT", "prompt 仍声明 nextQuestion（会与解析器漂移）");
}
{
  // ③ 模型严格按 prompt 协议输出合法 JSON → 必须被接受并生成下一问
  const db = fixture();
  await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const anchor = anchorOf(db);
  const fake = fakeModel(JSON.stringify({ turnKind: "question", question: { key: "steps", label: "操作顺序", prompt: "按顺序讲一遍？" } }));
  let res; let body;
  try {
    res = await turn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: ANSWER_FOR[anchor.key], answers: {}, mode: "harness", baseRevision: revOf(db) });
    body = await res.clone().json();
  } finally { fake.restore(); }
  if (res.status === 200 && body?.turn?.nextQuestion) pass("R1-ACCEPT", "按 prompt 协议输出 → 200 且生成下一问", `next=${body.turn.nextQuestion.key}`);
  else fail("R1-ACCEPT", "协议一致仍未被接受", `${res.status} ${JSON.stringify(body).slice(0, 120)}`);
  db.close();
}
{
  // ④ 错误 JSON 必须被明确拒绝，且不得伪造模型结果
  const db = fixture();
  await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const anchor = anchorOf(db);
  const revBefore = revOf(db);
  const fake = fakeModel("这不是 JSON");
  let res;
  try {
    res = await turn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: ANSWER_FOR[anchor.key], answers: {}, mode: "harness", baseRevision: revOf(db) });
  } finally { fake.restore(); }
  if (res.status === 503 && revOf(db) === revBefore) pass("R1-BADJSON", "错误 JSON → 503，且本轮不推进 revision（不伪造结果）");
  else fail("R1-BADJSON", "错误 JSON 处理异常", `status=${res.status} rev=${revBefore}→${revOf(db)}`);
  db.close();
}
{
  // ⑤ 缺必需字段必须被拒绝
  const db = fixture();
  await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const anchor = anchorOf(db);
  const cases = [
    ["缺 question 字段", JSON.stringify({ turnKind: "question" })],
    ["question 缺 prompt", JSON.stringify({ turnKind: "question", question: { key: "steps", label: "x" } })],
    ["未知 turnKind", JSON.stringify({ turnKind: "hack" })],
  ];
  const bad = [];
  for (const [label, payload] of cases) {
    const d = fixture();
    await turn(d, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(d) });
    const a = anchorOf(d);
    const fake = fakeModel(payload);
    let r;
    try {
      r = await turn(d, { projectId: P, workItemId: ITEM, questionKey: a.key, answer: ANSWER_FOR[a.key], answers: {}, mode: "harness", baseRevision: revOf(d) });
    } finally { fake.restore(); }
    if (!(r.status >= 400)) bad.push(`${label}(status=${r.status})`);
    d.close();
  }
  if (!bad.length) pass("R1-MISSING", `缺必需字段/未知 turnKind 全部被拒绝（${cases.length} 例）`);
  else fail("R1-MISSING", "存在未被拒绝的非法结构", bad.join("; "));
  db.close();
}
{
  // ⑥ 非法 questionKey 必须被拒绝（且不写入错误维度）
  const db = fixture();
  await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const anchor = anchorOf(db);
  const fake = fakeModel(JSON.stringify({ turnKind: "question", question: { key: "evil_dim", label: "x", prompt: "y" } }));
  let res; let body;
  try {
    res = await turn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: ANSWER_FOR[anchor.key], answers: {}, mode: "harness", baseRevision: revOf(db) });
    body = await res.clone().json();
  } finally { fake.restore(); }
  // 非法 key 会被 canonicalQuestionKey 归一到当前维度（安全兜底），关键是不能出现 evil_dim
  const cov = body?.turn?.coverage?.dimensions || {};
  if (res.status === 200 && !("evil_dim" in cov)) pass("R1-BADKEY", "非法 questionKey 不会被采纳为维度（已归一，无 evil_dim）");
  else if (res.status >= 400) pass("R1-BADKEY", "非法 questionKey 被拒绝", String(res.status));
  else fail("R1-BADKEY", "非法 questionKey 进入了覆盖维度", JSON.stringify(Object.keys(cov)));
  db.close();
}
{
  // ⑦ 解析边界（parseRunnerText 未导出，经 runHarness 端到端验证）
  const mkLedger = () => ({ statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [] });
  const frame = { projectId: P, runId: "R", questionKey: "steps", questionLabel: "实际怎么做", questionPrompt: "你按什么顺序操作？", answer: "先挑对标视频", materialRefs: [], persistedAnswers: {}, authorizedContext: null };
  const cases = [
    ["含噪但合法", '前置说明 {"turnKind":"question","question":{"key":"steps","label":"L","prompt":"P"}} 后置', true],
    ["无 JSON", "没有大括号的内容", false],
    ["空输出", "   ", false],
  ];
  const bad = [];
  for (const [label, payload, shouldPass] of cases) {
    let ok = true;
    try { await runHarness(JSON.parse(JSON.stringify(frame)), mkLedger(), async () => payload); } catch { ok = false; }
    if (ok !== shouldPass) bad.push(`${label}(期望${shouldPass ? "接受" : "拒绝"}实际${ok ? "接受" : "拒绝"})`);
  }
  if (!bad.length) pass("R1-PARSER", "解析边界：含噪合法 JSON 被接受；无 JSON / 空输出被明确拒绝");
  else fail("R1-PARSER", "解析边界异常", bad.join("; "));
}
{
  // ⑧ 提示词实际文本必须声明 question（经运行时捕获模型请求 prompt）
  const db = fixture();
  await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const anchor = anchorOf(db);
  const capture = {};
  const fake = fakeModel(JSON.stringify({ turnKind: "question", question: { key: "inputs", label: "先看什么", prompt: "你先看哪些信息？" } }), capture);
  try {
    await turn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: ANSWER_FOR[anchor.key], answers: {}, mode: "harness", baseRevision: revOf(db) });
  } finally { fake.restore(); }
  const prompt = capture.prompts[0] || "";
  const declaresQuestion = /"question":\{"key":"<七维之一或追问标识>"/.test(prompt);
  const declaresNextQuestion = /"nextQuestion":\{"key":"<七维之一或追问标识>"/.test(prompt);
  if (declaresQuestion && !declaresNextQuestion) pass("R1-PROMPT", "运行时捕获的提示词声明 question，不再声明 nextQuestion（与实际解析字段一致）");
  else fail("R1-PROMPT", "提示词字段声明仍不正确", `question=${declaresQuestion} nextQuestion=${declaresNextQuestion}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
// R2：锚点身份问题的受控恢复
// ═══════════════════════════════════════════════════════════════
console.log("\n── R2 受控恢复 ──");
{
  const hasWhitelist = APP_SRC.includes("RECOVERABLE_CODES") && APP_SRC.includes("question_anchor_missing") && APP_SRC.includes("question_identity_mismatch");
  const hasGuard = APP_SRC.includes("canRecoverQuestionIdentity") && APP_SRC.includes("payload.recoverable === true") && APP_SRC.includes("DIMENSION_KEYS.has");
  const singleAttempt = /if \(!canRecoverQuestionIdentity\(error\)\) throw error;/.test(APP_SRC);
  if (hasWhitelist && hasGuard && singleAttempt) pass("R2-GUARD", "恢复仅对白名单错误码 + 服务端 recoverable/expectedKey 生效，且每轮最多一次");
  else fail("R2-GUARD", "恢复守卫不完整", `whitelist=${hasWhitelist} guard=${hasGuard} single=${singleAttempt}`);
}
{
  const noBlindRetry = !/while\s*\(true\)/.test(APP_SRC.slice(APP_SRC.indexOf("canRecoverQuestionIdentity"), APP_SRC.indexOf("canRecoverQuestionIdentity") + 3000));
  const keepsAnswer = APP_SRC.includes("...turnPayload,");
  if (noBlindRetry && keepsAnswer) pass("R2-NOLOOP", "无无限重试；重试复用同一份员工回答载荷（不重复保存、不覆盖输入）");
  else fail("R2-NOLOOP", "重试结构可疑", `noLoop=${noBlindRetry} keepsAnswer=${keepsAnswer}`);
}
{
  // 行为侧：question_anchor_missing 与 question_identity_mismatch 都由服务端给出可判定信号
  const db = fixture();
  const first = await turn(db, { projectId: P, workItemId: ITEM, questionKey: "trigger", answer: "x", answers: {}, mode: "fixture", baseRevision: 0 });
  const firstBody = await first.clone().json();
  const rec = await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const recBody = await rec.clone().json();
  const anchor = anchorOf(db);
  const wrongKey = anchor.key === "handoff" ? "judgments" : "handoff";
  const mismatch = await turn(db, { projectId: P, workItemId: ITEM, questionKey: wrongKey, answer: "x", answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const mismatchBody = await mismatch.clone().json();
  const anchorSignal = first.status === 409 && firstBody.code === "question_anchor_missing" && firstBody.recoverable === true;
  const mismatchSignal = mismatch.status === 409 && mismatchBody.code === "question_identity_mismatch" && DIMS.includes(mismatchBody.expectedKey);
  const recoverable = rec.status === 200 && recBody.turn?.nextQuestion?.key;
  if (anchorSignal && mismatchSignal && recoverable) {
    pass("R2-SIGNAL", "两类可恢复错误均带服务端可判定信号；恢复签发可用", `anchor=${firstBody.code} mismatch=${mismatchBody.code}/${mismatchBody.expectedKey}`);
  } else {
    fail("R2-SIGNAL", "可恢复信号不完整", `anchor=${first.status}/${firstBody.code}/${firstBody.recoverable} mismatch=${mismatch.status}/${mismatchBody.code}/${mismatchBody.expectedKey}`);
  }
  db.close();
}
{
  // 不可恢复的错误不得被客户端当作可恢复：源码中不得把 403/500 纳入恢复
  const slice = APP_SRC.slice(APP_SRC.indexOf("const canRecoverQuestionIdentity"), APP_SRC.indexOf("const canRecoverQuestionIdentity") + 600);
  const onlyOneStatus = slice.includes("error.status !== 409");
  const noPermissionRecover = !/403|permission|forbidden/i.test(slice);
  if (onlyOneStatus && noPermissionRecover) pass("R2-STRICT", "恢复仅限 409；权限/跨项目类错误不进入恢复路径");
  else fail("R2-STRICT", "恢复范围过宽", `only409=${onlyOneStatus} noPerm=${noPermissionRecover}`);
}
{
  // 跨任务锚点必须被拒绝（不可恢复为"随便换个问题"）
  const db = fixture({ revision: 1, answers: { trigger: ANSWER_FOR.trigger }, ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], pendingQuestion: { key: "inputs", label: "x", prompt: "y", revision: 1, workItemId: "WI-ELSEWHERE", sig: "f" } } });
  const r = await turn(db, { projectId: P, workItemId: ITEM, questionKey: "inputs", answer: "x", answers: {}, mode: "fixture", baseRevision: 1 });
  const b = await r.clone().json();
  if (r.status === 409 && b.code === "question_anchor_missing") pass("R2-CROSS", "跨 workItemId 锚点 → 判为无效锚点 → 409（不接受）");
  else fail("R2-CROSS", "跨任务锚点未被拒绝", `${r.status} ${b.code}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
// R3：推断判定的持久化契约
// ═══════════════════════════════════════════════════════════════
console.log("\n── R3 判定持久化 ──");
{
  const hasFlush = APP_SRC.includes("scheduleInferenceVerdictFlush") && APP_SRC.includes("flushInferenceVerdictsNow");
  const calledOnChange = /scheduleInferenceVerdictFlush\(\);/.test(APP_SRC.slice(APP_SRC.indexOf("dataset.inferenceId"), APP_SRC.indexOf("dataset.inferenceId") + 3000));
  const verdictsOnly = /persistFormalEmployeeDraftNow\(\{ verdictsOnly: true \}\)/.test(APP_SRC);
  const debounced = APP_SRC.includes("inferenceVerdictFlushInFlight");
  if (hasFlush && calledOnChange && verdictsOnly && debounced) {
    pass("R3-AUTOFLUSH", "判定变更即调度去抖自动保存（verdictsOnly，不覆盖 ledger/answers），并防并发重入");
  } else {
    fail("R3-AUTOFLUSH", "判定自动保存不完整", `flush=${hasFlush} onChange=${calledOnChange} only=${verdictsOnly} guard=${debounced}`);
  }
}
{
  // 行为侧：verdictsOnly 语义（只推判定）在服务端确实只改判定、不动锚点与答案
  const db = fixture();
  await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const anchorBefore = anchorOf(db);
  const answersBefore = JSON.stringify(draftOf(db).answers);
  const r = await put(db, { answers: draftOf(db).answers, materialStatus: "provided", baseRevision: revOf(db), ledger: null, inferenceVerdicts: { "INF-1": { verdict: "agree" }, "INF-2": { verdict: "correct", correction: "其实是版权原因" } } });
  const after = draftOf(db);
  const anchorKept = after.ledger?.pendingQuestion?.key === anchorBefore?.key;
  const answersKept = JSON.stringify(after.answers) === answersBefore;
  const verdicts = after.inferenceVerdicts;
  if (r.status === 200 && anchorKept && answersKept && verdicts["INF-1"]?.verdict === "confirmed" && verdicts["INF-2"]?.verdict === "corrected" && verdicts["INF-2"].correction === "其实是版权原因") {
    pass("R3-PERSIST", "自动保存语义：锚点与答案不变，判定落库为 confirmed / corrected 且更正原文保留");
  } else {
    fail("R3-PERSIST", "自动保存语义异常", `status=${r.status} anchor=${anchorKept} answers=${answersKept} verdicts=${JSON.stringify(verdicts)}`);
  }
  db.close();
}
{
  // 未判定不得被自动确认：只提交部分判定时，其余保持未判定
  const db = fixture();
  await put(db, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { "INF-1": { verdict: "agree" } } });
  const v = draftOf(db).inferenceVerdicts;
  const onlyOne = Object.keys(v).length === 1 && v["INF-1"].verdict === "confirmed";
  if (onlyOne) pass("R3-NOAUTOCONFIRM", "只判定了 1 条时，其余推断不会被自动确认为已判定", JSON.stringify(Object.keys(v)));
  else fail("R3-NOAUTOCONFIRM", "出现自动确认", JSON.stringify(v));
  db.close();
}
{
  // 非法判定值不得成为"已判定"
  const db = fixture();
  await put(db, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { "INF-9": { verdict: "bogus" } } });
  const v = draftOf(db).inferenceVerdicts["INF-9"];
  if (v?.verdict === "unjudged") pass("R3-UNJUDGED", "非法判定值归一为 unjudged（不被当作已确认）");
  else fail("R3-UNJUDGED", "非法判定值处理异常", JSON.stringify(v));
  db.close();
}
{
  // 页面刷新后判定仍在：判定存于草稿，读取路径不依赖内存
  const db = fixture();
  await put(db, { answers: {}, materialStatus: "provided", baseRevision: 0, inferenceVerdicts: { "INF-A": { verdict: "correct", correction: "刷新后应仍在" } } });
  const reloaded = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
  const kept = reloaded.inferenceVerdicts["INF-A"]?.verdict === "corrected" && reloaded.inferenceVerdicts["INF-A"].correction === "刷新后应仍在";
  if (kept) pass("R3-RELOAD", "重新从库读取（模拟刷新）：判定与更正原文均保留");
  else fail("R3-RELOAD", "刷新后判定丢失", JSON.stringify(reloaded.inferenceVerdicts));
  db.close();
}
{
  // 必须存在一条把"判定"重新载入客户端状态的路径。
  // PILOT-08E/D1：回填现在经过词汇边界映射 formalVerdictToClientVerdict
  // （服务端 confirmed/corrected → 前端 agree/correct），因此断言按新结构校验。
  const restores = APP_SRC.includes("task.draftInferenceVerdicts")
    && APP_SRC.includes("state.formalInferenceVerdicts[id] = { verdict: clientVerdict")
    && APP_SRC.includes("formalVerdictToClientVerdict");
  if (restores) pass("R3-RESTORE", "客户端在任务载荷应用时把 draftInferenceVerdicts 回填进判定状态（含服务端→前端词汇映射）");
  else fail("R3-RESTORE", "缺少判定回填路径");
}
{
  // PILOT-08E/D1 已修复原先的 R3-REMAIN（刷新后判定区无法重建）：
  // 推断列表现由服务端落库（ledger.authoritativeInferences），客户端据以重建。
  // 这里把原先的"已知残留"断言改为**正向断言**，防止该修复被回退。
  const persistsInferences = APP_SRC.includes("ledger.authoritativeInferences")
    && APP_SRC.includes("state.formalAgentInferences = baselineInferences");
  if (persistsInferences) {
    pass("R3-REMAIN→FIXED", "PILOT-08E/D1 已修复：客户端从服务端权威基线（ledger.authoritativeInferences）重建推断列表");
  } else {
    fail("R3-REMAIN→FIXED", "推断列表缺少服务端持久化/重建路径（D1 可能被回退）");
  }
}

// ═══════════════════════════════════════════════════════════════
// R4 / R5：交叉引用（详细断言在 pilot04c_runtime）
// ═══════════════════════════════════════════════════════════════
console.log("\n── R4/R5 交叉引用 ──");
{
  const s = readFileSync(new URL("./pilot04c_runtime.mjs", import.meta.url), "utf8");
  const r4Conditional = /if \(repeatArrivals === 1\)/.test(s) && /else if \(repeatArrivals === 0\)/.test(s) && /else \{/.test(s);
  const r4ReadsActual = s.includes("Number(fake.state.arrivals)");
  // 无条件 pass 的判据：定位真正调用 pass() 的那一行，其上一行必须是条件行。
  // 注意：本文件自身也包含 "重复计费" 字样，因此只认 `pass("重复计费"` 开头的**语句行**。
  const lines4 = s.split("\n");
  const isCall = (l) => /^\s*pass\("重复计费"/.test(l);
  const idx = lines4.findIndex(isCall);
  const prev = idx > 0 ? lines4[idx - 1].trim() : "";
  const noUnconditional = idx > 0 && prev === "if (repeatArrivals === 1) {";
  if (r4Conditional && r4ReadsActual && noUnconditional) pass("R4-CROSS", "pilot04c 重复计费断言已恢复真实条件判断，读取实际调用次数，并区分 0/1/2");
  else fail("R4-CROSS", "重复计费断言仍不可信", `cond=${r4Conditional} reads=${r4ReadsActual} noUncond=${noUnconditional}`);
}
{
  const s = readFileSync(new URL("./pilot04c_runtime.mjs", import.meta.url), "utf8");
  const runtimeSnapshot = s.includes("WATCH_TABLES") && s.includes("const beforeSnap = snapshot(db0)") && s.includes("changedTables");
  const staticAux = s.includes("辅助静态检查");
  if (runtimeSnapshot && staticAux) pass("R5-CROSS", "pilot04c 写入边界断言以运行时全表前后快照为主，静态检查降为辅助");
  else fail("R5-CROSS", "写入边界断言仍以静态匹配为主", `runtime=${runtimeSnapshot} aux=${staticAux}`);
}
{
  // 运行时行为：一次真实轮次后，除 work_items.employee_draft_json 外无任何表变化
  const db = fixture();
  await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const TABLES = ["candidate_facts", "fact_judgments", "fact_second_confirmations", "decision_packets", "owner_decisions", "evidence_materials", "evidence_supplements", "enterprise_authorizations", "invitations", "project_memberships", "accounts", "projects", "events"];
  const beforeT = Object.fromEntries(TABLES.map((t) => [t, db.count(t)]));
  const beforeItem = JSON.stringify(db.get("SELECT stage,status,assigned_verifier_id,submission_version,handoff_status,evidence_json,alternative_explanations_json,material_status FROM work_items WHERE id=?", ITEM));
  // PILOT-09A-FIX/F1：本轮新增模型调用计量事件，需限定"本轮新增行"的范围
  const beforeMaxEventId = Number(db.get("SELECT COALESCE(MAX(id),0) AS m FROM events WHERE work_item_id = ?", ITEM).m);
  const anchor = anchorOf(db);
  const fake = fakeModel(JSON.stringify({ turnKind: "question", question: { key: "inputs", label: "先看什么", prompt: "你先看哪些信息？" } }));
  try {
    await turn(db, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: ANSWER_FOR[anchor.key], answers: {}, mode: "harness", baseRevision: revOf(db) });
  } finally { fake.restore(); }
  const afterT = Object.fromEntries(TABLES.map((t) => [t, db.count(t)]));
  const afterItem = JSON.stringify(db.get("SELECT stage,status,assigned_verifier_id,submission_version,handoff_status,evidence_json,alternative_explanations_json,material_status FROM work_items WHERE id=?", ITEM));
  const changed = TABLES.filter((t) => beforeT[t] !== afterT[t]);
  // PILOT-09A-FIX/F1：events 会新增模型调用计量行。**收紧而非放宽**：
  //   业务表必须零变化；events 的新增行必须**全部**是 model_call_* 计量事件。
  const businessChanged = changed.filter((t) => t !== "events");
  const nonMetering = db.all(
    "SELECT type FROM events WHERE work_item_id = ? AND id > ? AND type NOT IN ('model_call_reserved','model_call_started','model_call_succeeded','model_call_failed','model_call_timed_out')",
    ITEM, beforeMaxEventId,
  ).map((r) => r.type);
  if (businessChanged.length === 0 && nonMetering.length === 0 && beforeItem === afterItem) {
    pass("R5-RUNTIME", "运行时验证：业务表零变化；events 仅新增 model_call_* 计量行；未改 work_items 业务列", `events:+${afterT.events - beforeT.events}`);
  } else {
    fail("R5-RUNTIME", "轮次请求越界写入", `businessTables=${JSON.stringify(businessChanged)} nonMetering=${JSON.stringify(nonMetering)} itemChanged=${beforeItem !== afterItem}`);
  }
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
console.log("\npilot08c runtime: ok");
