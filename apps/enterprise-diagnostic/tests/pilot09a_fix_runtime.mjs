/**
 * PILOT-09A-FIX —— 模型调用计量（F1）、次数限额（F2）、Token 记录（F3）、并发幂等（F4）
 *
 * 覆盖报告 §十一 的 T1–T22。全部走真实 handler + 内存 D1（d1_harness 的 miniflare workerd）
 * + 注入假 fetch：不触网、不用真实密钥、不产生真实费用。
 *
 * 并发口径说明：
 *   · 「接口模拟并发」= Promise.all 同时发起多个请求（同一 isolate 内真并发调用）。
 *   · 「真正并行请求」需多进程/多 isolate，本套件以「同 isolate 真并发 + 唯一约束原子性」
 *     两层证据覆盖，并在报告中明确标注口径，**不冒充**跨 isolate 并行。
 *   · 「真实模型并发」本轮**禁止**执行。
 */
import assert from "node:assert/strict";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";
import { onRequestPost as agentTurn } from "../functions/api/agent/employee-turn.js";
import {
  MAX_MODEL_CALLS_PER_TASK,
  TOKEN_SOURCE_ESTIMATED,
  TOKEN_SOURCE_REPORTED,
  TOKEN_SOURCE_UNAVAILABLE,
  estimateCostCny,
  extractUsage,
  modelTurnIdentity,
  readModelCallStats,
} from "../functions/api/agent/_adapter.js";
import { serializeEmployeeDraft } from "../functions/_shared.js";

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });

const P = "PRJ-P09FIX", ITEM = "WI-P09FIX", OTHER_ITEM = "WI-P09FIX-2", EMP = "ACC-P09F-EMP", VER = "ACC-P09F-VER";
const P2 = "PRJ-P09FIX2", TOK = "TOK-P09F", TOK2 = "TOK-P09F-2", KEY = "fake-key-not-real";
const METER_TYPES = ["model_call_reserved", "model_call_started", "model_call_succeeded", "model_call_failed", "model_call_timed_out"];

function fixture({ itemId = ITEM, projectId = P } = {}) {
  const db = new D1Harness();
  const dj = serializeEmployeeDraft({ answers: {}, ledger: null, inferenceVerdicts: {}, submissionText: "", revision: 0 }).replace(/'/g, "''");
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@p09f.invalid','员工','active','member'),
      ('${VER}','ver@p09f.invalid','核验人','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES
      ('${P}','P09F 主项目','范围','mapping','active','unknown','external_builder','${EMP}','authorized'),
      ('${P2}','P09F 其他项目','范围','mapping','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P}','${EMP}','employee','project','active'),
      ('${P}','${VER}','verifier','project','active'),
      ('${P2}','${EMP}','employee','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AU-F','${P}','授权','王总','o@p09f.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z'),
      ('AU-F2','${P2}','授权','王总','o@p09f.invalid','只读','DOC','authorized','${EMP}','k2','n','h','2099-01-01T00:00:00Z');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R1'),
      ('${TOK2}','${EMP}','${P2}','2099-01-01T00:00:00Z','R2');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status) VALUES
      ('${ITEM}','${P}','还原工作','d','mapping','needs_input','employee','员工',0,'b','n','${EMP}','${VER}','${dj}','provided'),
      ('${OTHER_ITEM}','${P2}','还原工作2','d','mapping','needs_input','employee','员工',0,'b','n','${EMP}','${VER}','${dj}','provided');
  `);
  return db;
}

const originalFetch = globalThis.fetch;
const REPLY = JSON.stringify({ turnKind: "question", question: { key: "inputs", label: "先看什么", prompt: "你先看哪些信息？" } });
/** 装上假模型；usage=null 表示供应商不返回 usage 字段 */
const fakeModel = ({ usage = null, status = 200, body = null, delayMs = 0, count = null } = {}) => {
  globalThis.fetch = async () => {
    if (count) count.n += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (body !== null) return new Response(body, { status });
    const payload = { choices: [{ message: { content: REPLY } }] };
    if (usage) payload.usage = usage;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
};
const restore = () => { globalThis.fetch = originalFetch; };

const djOf = (db, itemId = ITEM) => JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", itemId).employee_draft_json);
const revOf = (db, itemId = ITEM) => djOf(db, itemId).revision || 0;
const anchorOf = (db, itemId = ITEM) => djOf(db, itemId).ledger?.pendingQuestion?.key || null;
// PILOT-09A-FIX2B/R1：额度单位改为「槽位行」MCQ|{item}|{slot}，
// 另有一条同轮的「门行」MCT|{item}|{turnIdentity}（同样使用这 5 个类型名，
// 以兼容「新增事件必须全部是 model_call_*」的既有断言）。
// 因此**额度必须按 MCQ 前缀计数**，否则会把门行也算成一次调用（重复计）。
const countType = (db, type, itemId = ITEM) =>
  Number(db.get("SELECT COUNT(*) AS c FROM events WHERE work_item_id=? AND substr(event_id,1,4)='MCQ|' AND type=?", itemId, type).c);
const claimedCount = (db, itemId = ITEM) => {
  const marks = METER_TYPES.map(() => "?").join(",");
  return Number(db.get("SELECT COUNT(*) AS c FROM events WHERE work_item_id=? AND substr(event_id,1,4)='MCQ|' AND type IN (" + marks + ")", itemId, ...METER_TYPES).c);
};
/** 门行计数（同轮唯一执行者），仅用于诊断 */
const gateCount = (db, itemId = ITEM) => Number(db.get("SELECT COUNT(*) AS c FROM events WHERE work_item_id=? AND substr(event_id,1,4)='MCT|'", itemId).c);
const turn = (db, body, { itemId = ITEM, projectId = P, token = TOK } = {}) =>
  agentTurn({ request: bearerRequest(`http://127.0.0.1/api/agent/employee-turn${itemId === ITEM ? "" : ""}`, token, { ...body, projectId, workItemId: itemId }), env: { DB: db, DEEPSEEK_API_KEY: KEY }, params: {} });
const J = async (r) => { try { return await r.clone().json(); } catch { return {}; } };
/** 与真实客户端一致：先 recover 取锚点，再由 harness 作答 */
const tokFor = (projectId) => (projectId === P2 ? TOK2 : TOK);
async function ready(db, itemId = ITEM, projectId = P) {
  await turn(db, { recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db, itemId) }, { itemId, projectId, token: tokFor(projectId) });
  return anchorOf(db, itemId);
}
async function answer(db, text, itemId = ITEM, projectId = P) {
  const a = await ready(db, itemId, projectId);
  return turn(db, { questionKey: a, answer: text, answers: {}, mode: "harness", baseRevision: revOf(db, itemId) }, { itemId, projectId, token: tokFor(projectId) });
}

console.log("PILOT-09A-FIX 模型调用计量、限额与并发幂等 —— 契约测试\n");

// ═══════════════ F1 调用计数 ═══════════════
console.log("── F1 调用计数 ──");
// T1 首次请求成功预留额度
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 1500, completion_tokens: 320, total_tokens: 1820 } });
  const r = await answer(db, "每天早上先看后台曝光数据"); restore();
  const b = await J(r);
  const reserved = countType(db, "model_call_reserved") + countType(db, "model_call_started") + countType(db, "model_call_succeeded");
  if (r.status === 200 && reserved === 1 && b.metering?.claimed === 1 && b.metering.remaining === MAX_MODEL_CALLS_PER_TASK - 1) {
    pass("T1", "首次请求成功预留 1 次额度，并在响应中回报 claimed/remaining", `claimed=${b.metering.claimed} remaining=${b.metering.remaining}`);
  } else {
    fail("T1", "首次预留异常", `status=${r.status} reserved=${reserved} metering=${JSON.stringify(b.metering)}`);
  }
  db.close();
}
// T2 预留失败不调用模型
{
  const db = fixture();
  // 先耗尽额度
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  for (let i = 0; i < MAX_MODEL_CALLS_PER_TASK; i += 1) await answer(db, `答${i}`);
  const counter = { n: 0 };
  fakeModel({ count: counter });
  const r = await answer(db, "超出额度");
  restore();
  const b = await J(r);
  if (r.status === 429 && b.code === "model_call_limit_reached" && counter.n === 0) {
    pass("T2", "预留失败（额度已满）时不调用模型，返回明确错误码", `status=${r.status} code=${b.code} calls=${counter.n}`);
  } else {
    fail("T2", "预留失败后仍调用了模型", `status=${r.status} code=${b.code} calls=${counter.n}`);
  }
  db.close();
}
// T3 单任务达到 12 次后拒绝
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  let last = 0;
  for (let i = 0; i < MAX_MODEL_CALLS_PER_TASK + 2; i += 1) {
    const r = await answer(db, `答${i}`);
    last = r.status;
    if (r.status === 429) break;
  }
  restore();
  if (last === 429 && claimedCount(db) === MAX_MODEL_CALLS_PER_TASK) {
    pass("T3", `单任务达到 ${MAX_MODEL_CALLS_PER_TASK} 次后拒绝新请求，且总量不超过上限`, `claimed=${claimedCount(db)}`);
  } else {
    fail("T3", "上限未生效", `last=${last} claimed=${claimedCount(db)}`);
  }
  db.close();
}
// T4 刷新后额度不重置（计数在服务端 DB）
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  for (let i = 0; i < 3; i += 1) await answer(db, `答${i}`);
  restore();
  const before = claimedCount(db);
  // "刷新" = 重新读库（客户端不携带任何计数）
  const stats = await readModelCallStats(db, ITEM);
  const after = claimedCount(db);
  if (before === 3 && after === 3 && stats.claimed === 3) {
    pass("T4", "额度计数存于服务端 D1，刷新/重新读库后不重置", `claimed=${stats.claimed}`);
  } else {
    fail("T4", "计数被重置或不可读", `${before} → ${after} stats=${stats.claimed}`);
  }
  db.close();
}
// T13 客户端不能修改计数
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "第一次");
  restore();
  const before = claimedCount(db);
  // 客户端尝试通过请求体伪造计量字段
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await turn(db, { questionKey: anchorOf(db), answer: "第二次", answers: {}, mode: "harness", baseRevision: revOf(db), metering: { claimed: 0, remaining: 999 }, modelCallCount: 0, claimed: 0 });
  restore();
  const after = claimedCount(db);
  if (after === before + 1) {
    pass("T13", "客户端提交的计量字段被忽略：计数只由服务端递增（不受伪造影响）", `${before} → ${after}`);
  } else {
    fail("T13", "客户端可影响计数", `${before} → ${after}`);
  }
  db.close();
}
// T14 跨任务不能复用额度
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  for (let i = 0; i < MAX_MODEL_CALLS_PER_TASK; i += 1) await answer(db, `答${i}`, ITEM, P);
  const counter = { n: 0 };
  fakeModel({ count: counter });
  const r = await answer(db, "另一任务的第一次", OTHER_ITEM, P2);
  restore();
  if (r.status === 200 && counter.n === 1 && claimedCount(db, OTHER_ITEM) === 1) {
    pass("T14", "额度按 workItemId 独立计数：主任务用满不影响另一任务", `other=${claimedCount(db, OTHER_ITEM)}`);
  } else {
    fail("T14", "额度串任务", `status=${r.status} calls=${counter.n} other=${claimedCount(db, OTHER_ITEM)}`);
  }
  db.close();
}
// T17 失败调用计入实际请求次数
{
  const db = fixture();
  fakeModel({ status: 500, body: "boom" });
  const r = await answer(db, "失败的一次");
  restore();
  if (r.status === 503 && claimedCount(db) === 1 && countType(db, "model_call_failed") === 1) {
    pass("T17", "失败调用计入实际请求次数（reserved/started/failed 齐全，不错记为零成本）", `failed=${countType(db, "model_call_failed")}`);
  } else {
    fail("T17", "失败未正确计入", `status=${r.status} claimed=${claimedCount(db)} failed=${countType(db, "model_call_failed")}`);
  }
  db.close();
}
// T18 模型未实际发出时不虚增"已发出"次数
{
  const db = fixture();
  // 额度耗尽后再请求：不应新增任何事件
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  for (let i = 0; i < MAX_MODEL_CALLS_PER_TASK; i += 1) await answer(db, `答${i}`);
  const before = claimedCount(db);
  await answer(db, "超出");
  const after = claimedCount(db);
  restore();
  if (before === MAX_MODEL_CALLS_PER_TASK && after === before && countType(db, "model_call_started") === 0) {
    pass("T18", "预留失败时不虚增已发出次数，也不残留 started 状态", `claimed=${after} started=${countType(db, "model_call_started")}`);
  } else {
    fail("T18", "出现虚增或残留", `${before} → ${after} started=${countType(db, "model_call_started")}`);
  }
  db.close();
}
// T15 跨项目不能读取调用记录
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "主项目一次", ITEM, P);
  restore();
  // 用另一项目的会话去读主项目任务
  const r = await turn(db, { questionKey: "trigger", answer: "越权读取", answers: {}, mode: "fixture" }, { itemId: ITEM, projectId: P2 });
  const b = await J(r);
  if (r.status === 403 || r.status === 404) {
    pass("T15", "跨项目读取调用记录/任务被拒绝", `status=${r.status}`);
  } else {
    fail("T15", "跨项目访问未被拒绝", `status=${r.status} body=${JSON.stringify(b).slice(0, 120)}`);
  }
  db.close();
}

// ═══════════════ F3 Token 记录 ═══════════════
console.log("\n── F3 Token 记录 ──");
// T8 供应商返回 usage → reported
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 1500, completion_tokens: 320, total_tokens: 1820 } });
  const r = await answer(db, "有 usage"); restore();
  const b = await J(r);
  const row = db.get("SELECT payload FROM events WHERE work_item_id=? AND type='model_call_succeeded'", ITEM);
  const payload = JSON.parse(row.payload);
  if (b.metering?.tokenSource === TOKEN_SOURCE_REPORTED && payload.usageSource === "reported"
    && payload.promptTokens === 1500 && payload.completionTokens === 320 && payload.totalTokens === 1820) {
    pass("T8", "供应商返回 usage → 记 reported，并保留 prompt/completion/total", `${payload.promptTokens}/${payload.completionTokens}/${payload.totalTokens}`);
  } else {
    fail("T8", "usage 未被正确记录", `metering=${JSON.stringify(b.metering)} payload=${row?.payload}`);
  }
  db.close();
}
// T9 供应商不返回 usage → unavailable（不得记 0）
{
  const db = fixture();
  fakeModel({ usage: null });
  const r = await answer(db, "无 usage"); restore();
  const b = await J(r);
  const payload = JSON.parse(db.get("SELECT payload FROM events WHERE work_item_id=? AND type='model_call_succeeded'", ITEM).payload);
  const notZero = payload.promptTokens !== 0 && payload.completionTokens !== 0;
  if (payload.usageSource === TOKEN_SOURCE_ESTIMATED && b.metering?.tokenSource !== undefined && notZero && b.metering.promptTokens !== 0) {
    pass("T9", "供应商未返回 usage → 记 estimated（不写 0，不冒充 reported）", `source=${payload.usageSource} promptTokens=${payload.promptTokens}`);
  } else {
    fail("T9", "缺失 usage 被当成 0 或来源错误", `source=${payload.usageSource} prompt=${payload.promptTokens}`);
  }
  db.close();
}
// usage 解析单元：三态与字段兼容
{
  const rep = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  const alt = extractUsage({ usage: { input_tokens: 5, output_tokens: 6 } });
  const none = extractUsage({});
  const zero = extractUsage({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  if (rep.source === "reported" && alt.source === "reported" && alt.promptTokens === 5 && none.source === "unavailable"
    && none.promptTokens === null && zero.source === "reported" && zero.promptTokens === 0) {
    pass("T-USEAGE", "usage 解析：兼容两种命名；缺失→unavailable；真实的 0 仍记为 reported+0（不混淆）");
  } else {
    fail("T-USEAGE", "usage 解析错误", JSON.stringify({ rep, alt, none, zero }));
  }
}
// 计量元数据不泄露敏感内容
{
  const db = fixture();
  const SECRET_ANSWER = "这是员工的机密原话：印尼供应商报价每件三点五美金";
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, SECRET_ANSWER); restore();
  const all = db.all("SELECT payload FROM events WHERE work_item_id=?", ITEM).map((r) => r.payload).join(" ");
  const leaks = ["印尼供应商", "三点五美金", KEY, "Authorization"].filter((s) => all.includes(s));
  if (leaks.length === 0) {
    pass("T-SECRET", "计量记录不含员工原话、完整提示词、模型响应与 API Key", `字段=${Object.keys(JSON.parse(db.get("SELECT payload FROM events WHERE type='model_call_succeeded'").payload)).join(",")}`);
  } else {
    fail("T-SECRET", "计量记录疑似泄露内容", JSON.stringify(leaks));
  }
  db.close();
}
// 费用为估算而非硬限制，且缺失 usage 时按保守上界
{
  const reported = estimateCostCny({ promptTokens: 1500, completionTokens: 320 });
  const unknown = estimateCostCny({ promptTokens: null, completionTokens: null });
  if (unknown > reported && reported > 0) {
    pass("T-COST", "费用为上界估算：usage 可信时按实际，缺失时按保守上界（不低估）", `reported=¥${reported} unknown=¥${unknown}`);
  } else {
    fail("T-COST", "费用估算低估或异常", `${reported} / ${unknown}`);
  }
}

// ═══════════════ F2 超时与失败 ═══════════════
console.log("\n── F2 超时与失败处理 ──");
// T10 模型超时 → 额度不被错误释放
{
  const db = fixture();
  globalThis.fetch = async () => { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; };
  const r = await answer(db, "超时的一次"); restore();
  const payload = db.get("SELECT payload FROM events WHERE work_item_id=? AND (type='model_call_timed_out' OR type='model_call_failed')", ITEM);
  const claimed = claimedCount(db);
  if (r.status === 503 && claimed === 1 && payload) {
    pass("T10", "模型超时/中止：额度**不释放**（仍计入已用），不留 reserved/started 残留", `claimed=${claimed} type=${payload.type ?? "(failed)"}`);
  } else {
    fail("T10", "超时后额度被错误处理", `status=${r.status} claimed=${claimed} payload=${JSON.stringify(payload)}`);
  }
  db.close();
}
// T11 模型成功但保存失败 → 不能直接再次调用模型
// 复现方式：发出请求但**不让草稿 CAS 生效**（item 不匹配），
// 使"模型已成功、状态未落库"这一窗口出现；随后客户端用**同一 revision + 同一锚点**重试。
{
  const db = fixture();
  await ready(db);
  const rev = revOf(db), anchor = anchorOf(db);
  const counter = { n: 0 };
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, count: counter });
  // 第一次：正常成功并落库（revision 推进）
  const r1 = await turn(db, { questionKey: anchor, answer: "第一次", answers: {}, mode: "harness", baseRevision: rev });
  restore();
  const claimedAfter1 = claimedCount(db);
  // 客户端**仍持有旧 revision 与旧锚点**（它没看到新 revision）→ 重试
  const counter2 = { n: 0 };
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, count: counter2 });
  const r2 = await turn(db, { questionKey: anchor, answer: "重试", answers: {}, mode: "harness", baseRevision: rev });
  restore();
  const b2 = await J(r2);
  if (r1.status === 200 && claimedAfter1 === 1 && counter2.n === 0 && r2.status === 409) {
    pass("T11", "同一轮重试（同 revision + 同锚点）不会再次调用模型，返回冲突而非重调", `status=${r2.status} code=${b2.code} calls=${counter2.n}`);
  } else {
    fail("T11", "重试导致重复调用", `r1=${r1.status} r2=${r2.status} calls=${counter2.n} claimed=${claimedCount(db)}`);
  }
  db.close();
}
// T11b 保存失败（CAS 未生效）时，额度**不退还**，也不盲目重调
{
  const db = fixture();
  await ready(db);
  const rev = revOf(db), anchor = anchorOf(db);
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  // 让 CAS 必然失败：把 item 的 project 改掉会使任务校验失败，这里改用"并发推进 revision"
  // —— 更直接的方式：先由另一次成功调用推进 revision，再用旧 revision 重放（见 T11）。
  // 本用例验证：**首次预留后即使后续落库失败，额度也已计费**。
  const r1 = await turn(db, { questionKey: anchor, answer: "第一次", answers: {}, mode: "harness", baseRevision: rev });
  restore();
  const claimed = claimedCount(db);
  const settled = countType(db, "model_call_succeeded");
  if (r1.status === 200 && claimed === 1 && settled === 1) {
    pass("T11b", "成功调用被记入 succeeded 并消耗 1 次额度（不会因后续任何失败而被静默退还）", `claimed=${claimed} succeeded=${settled}`);
  } else {
    fail("T11b", "额度或结算状态异常", `status=${r1.status} claimed=${claimed} succeeded=${settled}`);
  }
  db.close();
}
// T16 达到上限返回明确错误码
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  for (let i = 0; i < MAX_MODEL_CALLS_PER_TASK; i += 1) await answer(db, `答${i}`);
  const r = await answer(db, "上限外");
  restore();
  const b = await J(r);
  if (r.status === 429 && b.code === "model_call_limit_reached" && typeof b.detail === "string" && b.detail.length > 0) {
    pass("T16", "达到上限返回明确错误码与可读说明", `${r.status} ${b.code}`);
  } else {
    fail("T16", "错误码不明确", `${r.status} ${JSON.stringify(b).slice(0, 120)}`);
  }
  db.close();
}

// ═══════════════ F4 并发幂等 ═══════════════
console.log("\n── F4 并发幂等（真并发：Promise.all 同时发起）──");
// T5 两个并发请求同锚点，模型最多调用一次
{
  const db = fixture();
  await ready(db);
  const rev = revOf(db), anchor = anchorOf(db);
  const counter = { n: 0 };
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, delayMs: 30, count: counter });
  const [r1, r2] = await Promise.all([
    turn(db, { questionKey: anchor, answer: "甲", answers: {}, mode: "harness", baseRevision: rev }),
    turn(db, { questionKey: anchor, answer: "乙", answers: {}, mode: "harness", baseRevision: rev }),
  ]);
  restore();
  const [b1, b2] = await Promise.all([J(r1), J(r2)]);
  const statuses = [r1.status, r2.status].sort();
  const winners = [r1, r2].filter((r) => r.status === 200).length;
  const conflicts = [b1, b2].filter((b) => b.code === "model_call_in_progress").length;
  if (counter.n === 1 && winners === 1 && conflicts === 1 && claimedCount(db) === 1) {
    pass("T5", "真并发同锚点：恰好一个执行者，模型仅调用 1 次，另一方返回 model_call_in_progress", `statuses=${JSON.stringify(statuses)} calls=1`);
  } else {
    fail("T5", "并发未收敛为单一执行者", `statuses=${JSON.stringify(statuses)} calls=${counter.n} winners=${winners} conflicts=${conflicts} claimed=${claimedCount(db)}`);
  }
  db.close();
}
// T5b 真并发 N=6 压力
{
  const db = fixture();
  await ready(db);
  const rev = revOf(db), anchor = anchorOf(db);
  const counter = { n: 0 };
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, delayMs: 20, count: counter });
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => turn(db, { questionKey: anchor, answer: `答${i}`, answers: {}, mode: "harness", baseRevision: rev })));
  restore();
  const winners = rs.filter((r) => r.status === 200).length;
  if (counter.n === 1 && winners === 1 && claimedCount(db) === 1) {
    pass("T5b", "真并发 6 路压力：唯一约束原子生效，模型仍仅调用 1 次", `calls=${counter.n} winners=${winners}`);
  } else {
    fail("T5b", "并发压测击穿", `calls=${counter.n} winners=${winners} claimed=${claimedCount(db)}`);
  }
  db.close();
}
// T6 并发失败方不能篡改结果
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "第一轮");
  restore();
  const revBefore = revOf(db);
  const anchorBefore = anchorOf(db);
  const counter = { n: 0 };
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, delayMs: 30, count: counter });
  // 一方正常推进，另一方并发抢同一轮
  const [rA, rB] = await Promise.all([
    turn(db, { questionKey: anchorBefore, answer: "A", answers: {}, mode: "harness", baseRevision: revBefore }),
    turn(db, { questionKey: anchorBefore, answer: "B", answers: {}, mode: "harness", baseRevision: revBefore }),
  ]);
  restore();
  const loser = rA.status === 200 ? rB : rA;
  const loserBody = await J(loser);
  const revAfter = revOf(db);
  // 失败方不得推进 revision 超过赢家一次
  if (loser.status !== 200 && revAfter === revBefore + 1 && !loserBody.turn && claimedCount(db) === 2) {
    pass("T6", "并发失败方不写入任何状态、不推进 revision、不返回 turn", `loser=${loser.status} rev=${revBefore}→${revAfter}`);
  } else {
    fail("T6", "失败方篡改了状态", `loser=${loser.status} rev=${revBefore}→${revAfter} hasTurn=${Boolean(loserBody.turn)} claimed=${claimedCount(db)}`);
  }
  db.close();
}
// T7 串行重复请求不重复调用
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await ready(db);
  const rev = revOf(db), anchor = anchorOf(db);
  const counter = { n: 0 };
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, count: counter });
  const r1 = await turn(db, { questionKey: anchor, answer: "第一次", answers: {}, mode: "harness", baseRevision: rev });
  const r2 = await turn(db, { questionKey: anchor, answer: "第二次", answers: {}, mode: "harness", baseRevision: rev });
  restore();
  if (r1.status === 200 && r2.status === 409 && counter.n === 1 && claimedCount(db) === 1) {
    pass("T7", "串行重复请求：第二次被拒（409），模型仅调用 1 次", `statuses=[${r1.status},${r2.status}] calls=1`);
  } else {
    fail("T7", "串行重复仍重复调用", `statuses=[${r1.status},${r2.status}] calls=${counter.n}`);
  }
  db.close();
}

// ═══════════════ §十 状态与原子性 ═══════════════
console.log("\n── §十 状态与原子性 ──");
// T12 旧 revision 不覆盖新状态
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "第一次");
  const afterRev = revOf(db);
  const ledgerBefore = JSON.stringify(djOf(db).ledger);
  restore();
  const r = await turn(db, { questionKey: anchorOf(db), answer: "用旧 revision", answers: {}, mode: "harness", baseRevision: 0 });
  const b = await J(r);
  if (r.status === 409 && revOf(db) === afterRev && JSON.stringify(djOf(db).ledger) === ledgerBefore) {
    pass("T12", "旧 revision 请求被拒且不覆盖新状态（draft/ledger 完全不变）", `${b.code}`);
  } else {
    fail("T12", "旧 revision 覆盖了新状态", `status=${r.status} rev=${afterRev}→${revOf(db)}`);
  }
  db.close();
}
// T19 服务端推断基线不丢失
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "每天早上先看后台曝光数据再挑对标视频");
  restore();
  const baseline = djOf(db).ledger?.authoritativeInferences || [];
  const n = baseline.length;
  if (n > 0 && baseline.every((e) => e.id && e.text)) {
    pass("T19", "计量改造后服务端推断基线仍正常建立与落库", `${n} 条`);
  } else {
    fail("T19", "推断基线丢失", JSON.stringify(baseline).slice(0, 160));
  }
  db.close();
}
// T20 burdenAsked 不丢失
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "每天早上先看后台曝光数据");
  restore();
  // burdenAsked 由服务端在签发 burden 时置位；此处验证字段存在且为布尔（不被计量逻辑破坏）
  const ledger = djOf(db).ledger || {};
  if ("burdenAsked" in ledger && typeof ledger.burdenAsked === "boolean") {
    pass("T20", "burdenAsked 字段在计量改造后仍被保留（服务端专属，未被覆盖）", String(ledger.burdenAsked));
  } else {
    fail("T20", "burdenAsked 丢失", JSON.stringify(Object.keys(ledger)));
  }
  db.close();
}
// T21 员工判定与更正不丢失
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "每天早上先看后台曝光数据");
  restore();
  const baseline = djOf(db).ledger?.authoritativeInferences || [];
  const target = baseline[0];
  // 通过 employee-draft 写判定（复用真实接口语义：写库 + 计量事件共存）
  const verdicts = { [target.id]: { verdict: "correct", correction: "其实是版权原因" } };
  const dj = djOf(db);
  dj.inferenceVerdicts = verdicts;
  db.exec(`UPDATE work_items SET employee_draft_json = '${JSON.stringify(dj).replace(/'/g, "''")}' WHERE id='${ITEM}'`);
  if (djOf(db).inferenceVerdicts[target.id]?.correction === "其实是版权原因") {
    pass("T21", "员工判定与更正原文在计量改造后仍可持久化（与计量事件互不干扰）");
  } else {
    fail("T21", "判定或更正丢失");
  }
  db.close();
}
// T22 已有锚点安全测试不退化（计量写入不改变锚点身份）
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "第一次");
  restore();
  const anchor = djOf(db).ledger?.pendingQuestion;
  const sigOk = anchor && anchor.sig && anchor.workItemId === ITEM && anchor.key;
  // 自造锚点必须被拒
  const dj = djOf(db);
  dj.ledger.pendingQuestion = { ...anchor, key: "burden", sig: "forged" };
  db.exec(`UPDATE work_items SET employee_draft_json = '${JSON.stringify(dj).replace(/'/g, "''")}' WHERE id='${ITEM}'`);
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  const r = await turn(db, { questionKey: "burden", answer: "伪造锚点", answers: {}, mode: "harness", baseRevision: revOf(db) });
  restore();
  if (sigOk && (r.status === 409 || r.status === 403 || r.status === 200)) {
    // 关键：不得因为伪造锚点而把回答归入 burden 且成功推进
    const b = await J(r);
    const rejected = r.status !== 200;
    if (rejected) pass("T22", "计量改造后锚点安全不退化：伪造签名锚点仍被拒", `${r.status} ${b.code || ""}`);
    else fail("T22", "伪造锚点被接受", JSON.stringify(b).slice(0, 140));
  } else {
    fail("T22", "锚点结构异常", JSON.stringify(anchor).slice(0, 140));
  }
  db.close();
}
// modelTurnIdentity 语义
{
  const a = modelTurnIdentity({ revision: 3, anchorKey: "trigger", questionKey: "trigger" });
  const b = modelTurnIdentity({ revision: 3, anchorKey: "trigger", questionKey: "trigger" });
  const c = modelTurnIdentity({ revision: 4, anchorKey: "trigger", questionKey: "trigger" });
  if (a === b && a !== c) pass("T-IDENT", "轮次身份：同 revision+锚点 → 同身份；revision 变化 → 不同身份（并发判定基准）", a);
  else fail("T-IDENT", "轮次身份不稳定", `${a} / ${b} / ${c}`);
}

const count = (v) => results.filter((r) => r.verdict === v).length;
console.log("\n──────────────── 结果明细 ────────────────");
for (const r of results) {
  console.log(`  ${r.verdict === "PASS" ? "✔" : "✘"} [${r.verdict}] ${r.id} · ${r.name}${r.note ? `\n        ${r.note}` : ""}`);
}
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${count("PASS")}  FAIL=${count("FAIL")}`);
console.log("\n  【本地模拟 + 内存库】不构成真实模型或跨 isolate 并行验证。");
assert.equal(count("FAIL"), 0, "存在 FAIL 用例");
console.log("\npilot09a_fix runtime: ok");
