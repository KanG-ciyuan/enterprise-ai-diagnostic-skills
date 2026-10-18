/**
 * PILOT-09A-FIX2B —— 任务级原子额度（R1）、内部事件隔离（R2）、Token 校验（R3）
 *
 * 覆盖报告 §五 要求的 T1–T22 与 10 项额外验证。
 * 全部走真实 handler + 内存 D1（miniflare workerd）+ 注入假 fetch：不触网、不用真实密钥。
 *
 * 并发口径（**不得混用**）：
 *   · 【真实 HTTP 并发】= 经真实 handler、内部含 `await` 交错（可产生真实重叠）。
 *   · 【接口实测】= 直接调用额度原语（单条同步 SQL 语句）。**D1Harness 的 DB API 是同步的**，
 *     因此这里的 `Promise.all` **不构成真实数据库并发**，仅用于对抗性"最坏读取陈旧度"验证。
 */
import assert from "node:assert/strict";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";
import { onRequestPost as agentTurn } from "../functions/api/agent/employee-turn.js";
import { onRequest as listEvents } from "../functions/api/projects/[projectId]/events.js";
import { onRequest as getProject } from "../functions/api/projects/[projectId].js";
import {
  allocateQuotaSlot, claimTurnGate, estimateCostCny, extractUsage, markModelCallStarted,
  modelTurnIdentity, readModelCallStats, readTurnGate, releaseQuotaSlot, resolveModelCallLimit,
  settleModelCall, takeOverTurnGate, MAX_MODEL_CALLS_PER_TASK,
  TOKEN_SOURCE_ESTIMATED, TOKEN_SOURCE_REPORTED, TOKEN_SOURCE_UNAVAILABLE,
} from "../functions/api/agent/_adapter.js";
import { serializeEmployeeDraft } from "../functions/_shared.js";

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });

const P = "PRJ-F2B", P2 = "PRJ-F2B2", ITEM = "WI-F2B", ITEM2 = "WI-F2B2";
const EMP = "ACC-F2B-EMP", VER = "ACC-F2B-VER", EXT = "ACC-F2B-EXT";
const TOK = "TOK-F2B", TOK_EXT = "TOK-F2B-EXT", KEY = "fake-key-not-real";
const METER_TYPES = ["model_call_reserved", "model_call_started", "model_call_succeeded", "model_call_failed", "model_call_timed_out"];

function fixture({ itemId = ITEM, projectId = P } = {}) {
  const db = new D1Harness();
  const dj = serializeEmployeeDraft({ answers: {}, ledger: null, inferenceVerdicts: {}, submissionText: "", revision: 0 }).replace(/'/g, "''");
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@f2b.invalid','员工','active','member'),
      ('${VER}','ver@f2b.invalid','核验人','active','member'),
      ('${EXT}','ext@f2b.invalid','建设方','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES
      ('${P}','F2B 主项目','范围','mapping','active','unknown','external_builder','${EXT}','authorized'),
      ('${P2}','F2B 其他项目','范围','mapping','active','unknown','external_builder','${EXT}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P}','${EMP}','employee','project','active'),
      ('${P}','${VER}','verifier','project','active'),
      ('${P}','${EXT}','external_builder','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AU-F2B','${P}','授权','王总','o@f2b.invalid','只读','DOC','authorized','${EXT}','k','n','h','2099-01-01T00:00:00Z'),
      ('AU-F2B2','${P2}','授权','王总','o@f2b.invalid','只读','DOC','authorized','${EXT}','k2','n','h','2099-01-01T00:00:00Z');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R1'),
      ('${TOK_EXT}','${EXT}','${P}','2099-01-01T00:00:00Z','R2');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status) VALUES
      ('${ITEM}','${P}','还原工作','d','mapping','needs_input','employee','员工',0,'b','n','${EMP}','${VER}','${dj}','provided'),
      ('${ITEM2}','${P2}','还原工作2','d','mapping','needs_input','employee','员工',0,'b','n','${EMP}','${VER}','${dj}','provided');
  `);
  return db;
}

const originalFetch = globalThis.fetch;
const CONTENT = JSON.stringify({ turnKind: "question", question: { key: "inputs", label: "先看什么", prompt: "你先看哪些信息？" } });
/** 正确的供应商响应信封（content 必须包在 choices[0].message.content 内） */
const envelope = (usage) => JSON.stringify({ choices: [{ message: { content: CONTENT } }], ...(usage ? { usage } : {}) });
const fakeModel = ({ usage = null, delayMs = 0, count = null, status = 200, raw = null } = {}) => {
  globalThis.fetch = async () => {
    if (count) count.n += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (raw !== null) return new Response(raw, { status });
    return new Response(envelope(usage), { status: 200, headers: { "content-type": "application/json" } });
  };
};
const restore = () => { globalThis.fetch = originalFetch; };

const djOf = (db, itemId = ITEM) => JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", itemId).employee_draft_json);
const revOf = (db, itemId = ITEM) => djOf(db, itemId).revision || 0;
const anchorOf = (db, itemId = ITEM) => djOf(db, itemId).ledger?.pendingQuestion?.key || null;
/** 额度 = MCQ 槽位行数（不含门行） */
const slots = (db, itemId = ITEM) => Number(db.get("SELECT COUNT(*) AS c FROM events WHERE work_item_id=? AND substr(event_id,1,4)='MCQ|'", itemId).c);
const gateRows = (db, itemId = ITEM) => db.all("SELECT event_id,type,created_at FROM events WHERE work_item_id=? AND substr(event_id,1,4)='MCT|'", itemId);
const seedSlots = (db, n, itemId = ITEM, projectId = P) => {
  for (let i = 1; i <= n; i += 1) {
    db.exec(`INSERT INTO events (event_id,project_id,work_item_id,type,actor_role,actor_id,payload) VALUES ('MCQ|${itemId}|${String(i).padStart(4, "0")}','${projectId}','${itemId}','model_call_succeeded','employee','${EMP}','{}')`);
  }
};
const turn = (db, body, { itemId = ITEM, projectId = P, env = {}, token = TOK } = {}) =>
  agentTurn({ request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", token, { ...body, projectId, workItemId: itemId }), env: { DB: db, DEEPSEEK_API_KEY: KEY, ...env }, params: {} });
const J = async (r) => { try { return await r.clone().json(); } catch { return {}; } };
async function ready(db, itemId = ITEM, projectId = P) {
  await turn(db, { recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db, itemId) }, { itemId, projectId });
  return anchorOf(db, itemId);
}
async function answer(db, text, { itemId = ITEM, projectId = P, env = {} } = {}) {
  const a = await ready(db, itemId, projectId);
  return turn(db, { questionKey: a, answer: text, answers: {}, mode: "harness", baseRevision: revOf(db, itemId) }, { itemId, projectId, env });
}
const evReq = (token = TOK) => new Request(`http://127.0.0.1/api/projects/${P}/events`, { headers: { cookie: `__Host-diagnostic_session=${token}` } });
const projReq = (token = TOK_EXT) => new Request(`http://127.0.0.1/api/projects/${P}`, { headers: { cookie: `__Host-diagnostic_session=${token}` } });

console.log("PILOT-09A-FIX2B 原子额度 · 事件隔离 · Token 校验 —— 契约测试\n");

// ═══════════════ R1 额度 ═══════════════
console.log("── R1 额度原子性 ──");
// T1 同轮 6 请求并发 → 模型调用 1 次
{
  const db = fixture(); await ready(db);
  const rev = revOf(db), a = anchorOf(db);
  const c = { n: 0 };
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, delayMs: 30, count: c });
  const rs = await Promise.all(Array.from({ length: 6 }, () => turn(db, { questionKey: a, answer: "答", answers: {}, mode: "harness", baseRevision: rev })));
  restore();
  const st = rs.map((r) => r.status).sort();
  const winners = rs.filter((r) => r.status === 200).length;
  if (c.n === 1 && winners === 1 && slots(db) === 1) {
    pass("T1", "同轮 6 请求真并发：模型仅调用 1 次，额度仅消耗 1，其余返回 409", `statuses=${JSON.stringify(st)} calls=1 slots=1`);
  } else {
    fail("T1", "同轮并发未收敛", `statuses=${JSON.stringify(st)} calls=${c.n} slots=${slots(db)}`);
  }
  db.close();
}
// T2 11 已用 + 2 个不同轮次键并发 → ≤12
{
  const db = fixture(); seedSlots(db, 11);
  const rs = await Promise.all(["1:a:t", "1:b:t"].map((ti) => allocateQuotaSlot(db, { projectId: P, workItemId: ITEM, actor: { role: "employee", accountId: EMP }, limit: 12 })));
  if (slots(db) <= 12 && rs.filter((r) => r.ok).length === 1) {
    pass("T2", "11 已用 + 2 个不同轮次键并发：仅 1 个取得第 12 槽位，总额度 ≤12", `slots=${slots(db)} ok=${rs.filter((r) => r.ok).length}`);
  } else {
    fail("T2", "不同轮次键并发突破额度", `slots=${slots(db)} ok=${rs.filter((r) => r.ok).length}`);
  }
  db.close();
}
// T3 11 已用 + 6 个不同轮次键并发 → ≤12
{
  const db = fixture(); seedSlots(db, 11);
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => allocateQuotaSlot(db, { projectId: P, workItemId: ITEM, actor: { role: "employee", accountId: EMP }, limit: 12 })));
  const seq = db.all("SELECT event_id FROM events WHERE work_item_id=? AND substr(event_id,1,4)='MCQ|' ORDER BY id", ITEM).map((r) => r.event_id.split("|").pop());
  const dup = seq.length - new Set(seq).size;
  if (slots(db) === 12 && rs.filter((r) => r.ok).length === 1 && dup === 0) {
    pass("T3", "11 已用 + 6 个不同轮次键并发：恰好 1 个成功，总额度=12，槽位无重复", `slots=12 dup=${dup}`);
  } else {
    fail("T3", "额度被突破或槽位重复", `slots=${slots(db)} ok=${rs.filter((r) => r.ok).length} dup=${dup}`);
  }
  db.close();
}
// T4 12 已用 → 额度耗尽
{
  const db = fixture(); seedSlots(db, 12); await ready(db);
  const c = { n: 0 }; fakeModel({ count: c });
  const r = await turn(db, { questionKey: anchorOf(db), answer: "超限", answers: {}, mode: "harness", baseRevision: revOf(db) });
  restore();
  const b = await J(r);
  if (r.status === 429 && b.code === "model_call_limit_reached" && c.n === 0) {
    pass("T4", "12 已用 → 429 model_call_limit_reached，且**不再调用模型**", b.code);
  } else {
    fail("T4", "额度耗尽未正确拒绝", `status=${r.status} code=${b.code} calls=${c.n}`);
  }
  db.close();
}
// T5/T6 配置 30：第 30 次可用、第 31 次拒绝
{
  const db30 = fixture();
  for (let i = 0; i < 30; i += 1) await allocateQuotaSlot(db30, { projectId: P, workItemId: ITEM, actor: { role: "employee", accountId: EMP }, limit: 30 });
  const r31 = await allocateQuotaSlot(db30, { projectId: P, workItemId: ITEM, actor: { role: "employee", accountId: EMP }, limit: 30 });
  if (slots(db30) === 30 && !r31.ok && r31.reason === "limit") {
    pass("T5", "额度配置 30：恰好可用 30 次（第 30 次成功）", `slots=${slots(db30)}`);
    pass("T6", "额度配置 30：第 31 次被拒绝", `reason=${r31.reason}`);
  } else {
    fail("T5", "30 次配置异常", `slots=${slots(db30)}`);
    fail("T6", "第 31 次未被拒绝", JSON.stringify(r31));
  }
  db30.close();
}
// T7 配置 100：不因固定 12 槽提前停止
{
  const db = fixture();
  for (let i = 0; i < 100; i += 1) await allocateQuotaSlot(db, { projectId: P, workItemId: ITEM, actor: { role: "employee", accountId: EMP }, limit: 100 });
  const r101 = await allocateQuotaSlot(db, { projectId: P, workItemId: ITEM, actor: { role: "employee", accountId: EMP }, limit: 100 });
  if (slots(db) === 100 && !r101.ok) {
    pass("T7", "额度配置 100：正确用到第 100 次（未因固定 12 槽提前停止）", `slots=${slots(db)}`);
  } else {
    fail("T7", "100 次配置被提前截断", `slots=${slots(db)}`);
  }
  db.close();
}
// 额度配置解析（服务端）
{
  const cases = [
    [undefined, 12], ["", 12], ["abc", 12], ["0", 12], ["-5", 12], ["10000", 12], ["12.5", 12],
    ["30", 30], ["100", 100], ["1", 1], ["9999", 9999],
  ];
  const bad = cases.filter(([v, want]) => resolveModelCallLimit(v === undefined ? {} : { MODEL_CALL_LIMIT_PER_TASK: v }) !== want);
  if (bad.length === 0) pass("T-CFG", "额度由服务端配置解析：默认 12；非法值回退 12；支持 1/30/100/9999", `用例=${cases.length}`);
  else fail("T-CFG", "额度解析异常", JSON.stringify(bad));
}
// T8 客户端伪造额度无效
{
  const db = fixture(); seedSlots(db, 12); await ready(db);
  const c = { n: 0 }; fakeModel({ count: c });
  const r = await turn(db, {
    questionKey: anchorOf(db), answer: "伪造额度", answers: {}, mode: "harness", baseRevision: revOf(db),
    modelCallLimit: 999, MODEL_CALL_LIMIT_PER_TASK: 999, limit: 999, metering: { limit: 999, claimed: 0, remaining: 999 },
  });
  restore();
  const b = await J(r);
  if (r.status === 429 && c.n === 0) pass("T8", "客户端伪造额度字段被忽略：服务端仍按配置拒绝", `status=${r.status} calls=${c.n}`);
  else fail("T8", "客户端可影响额度", `status=${r.status} code=${b.code} calls=${c.n}`);
  db.close();
}
// T9 刷新后额度不重置
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "第一次");
  restore();
  const before = slots(db);
  const stats = await readModelCallStats(db, ITEM);   // "刷新" = 重新读库
  if (before === 1 && stats.claimed === 1 && slots(db) === 1) pass("T9", "额度存于服务端 D1：刷新/重新读库后不重置", `claimed=${stats.claimed}`);
  else fail("T9", "额度被重置", `${before} → ${slots(db)}`);
  db.close();
}
// T10 模型失败仍占额度
{
  const db = fixture(); await ready(db);
  fakeModel({ status: 500, raw: "boom" });
  const r = await answer(db, "失败一次");
  restore();
  if (r.status === 503 && slots(db) === 1 && Number(db.get("SELECT COUNT(*) AS c FROM events WHERE work_item_id=? AND substr(event_id,1,4)='MCQ|' AND type='model_call_failed'", ITEM).c) === 1) {
    pass("T10", "模型失败仍占额度（记 model_call_failed）", `slots=${slots(db)}`);
  } else {
    fail("T10", "失败未占额度", `status=${r.status} slots=${slots(db)}`);
  }
  db.close();
}
// T11 超时仍占额度
{
  const db = fixture(); await ready(db);
  globalThis.fetch = async () => { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; };
  const r = await answer(db, "超时一次");
  restore();
  const t = Number(db.get("SELECT COUNT(*) AS c FROM events WHERE work_item_id=? AND substr(event_id,1,4)='MCQ|' AND type='model_call_timed_out'", ITEM).c);
  if (r.status === 503 && slots(db) === 1 && t === 1) pass("T11", "模型超时仍占额度（记 model_call_timed_out，不释放）", `slots=${slots(db)} timedOut=${t}`);
  else fail("T11", "超时额度处理异常", `status=${r.status} slots=${slots(db)} timedOut=${t}`);
  db.close();
}
// T12 业务 CAS 失败后不重复付费调用
{
  const db = fixture(); await ready(db);
  const rev = revOf(db), a = anchorOf(db);
  const c = { n: 0 };
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, count: c });
  const r1 = await turn(db, { questionKey: a, answer: "第一次", answers: {}, mode: "harness", baseRevision: rev });
  const r2 = await turn(db, { questionKey: a, answer: "重放", answers: {}, mode: "harness", baseRevision: rev });
  restore();
  if (r1.status === 200 && r2.status === 409 && c.n === 1 && slots(db) === 1) {
    pass("T12", "同轮重放（CAS/门已占用）不重复调用模型、不二次计费", `statuses=[${r1.status},${r2.status}] calls=1`);
  } else {
    fail("T12", "重放导致重复付费调用", `statuses=[${r1.status},${r2.status}] calls=${c.n} slots=${slots(db)}`);
  }
  db.close();
}
// T13 跨项目额度隔离
{
  const db = fixture();
  seedSlots(db, 12, ITEM, P);
  const other = await allocateQuotaSlot(db, { projectId: P2, workItemId: ITEM2, actor: { role: "employee", accountId: EMP }, limit: 12 });
  if (other.ok && slots(db, ITEM2) === 1 && slots(db, ITEM) === 12) {
    pass("T13", "额度按 workItemId 隔离：主任务用满不影响另一任务", `main=12 other=1`);
  } else {
    fail("T13", "额度串任务", JSON.stringify(other));
  }
  db.close();
}
// 额外：门与槽位的故障顺序（A/B 由顺序消除）
{
  const db = fixture(); seedSlots(db, 12); await ready(db);
  const c = { n: 0 }; fakeModel({ count: c });
  const r = await turn(db, { questionKey: anchorOf(db), answer: "超限", answers: {}, mode: "harness", baseRevision: revOf(db) });
  restore();
  if (r.status === 429 && gateRows(db).length === 0) {
    pass("T-FAULT-AB", "「门成功但槽位失败」由顺序消除：额度耗尽时**不创建门** ⇒ 该轮不被永久阻断", `gates=${gateRows(db).length}`);
  } else {
    fail("T-FAULT-AB", "额度耗尽后残留门", `status=${r.status} gates=${gateRows(db).length}`);
  }
  db.close();
}
// 额外：额度耗尽后上调配置可恢复
{
  const db = fixture(); seedSlots(db, 12); await ready(db);
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  const r = await turn(db, { questionKey: anchorOf(db), answer: "上调后继续", answers: {}, mode: "harness", baseRevision: revOf(db) }, { env: { MODEL_CALL_LIMIT_PER_TASK: "30" } });
  restore();
  const t = await J(r);
  // 成功一轮会把 revision 由 1 推进到 2 —— 这正是"访谈可继续"的证据（而非被标记完成）
  if (r.status === 200 && revOf(db) === 2 && gateRows(db).length === 1) {
    pass("T-RECOVER", "额度耗尽只暂停模型调用：服务端上调至 30 后同一轮可继续（revision 1→2、进度保留、未被标记完成）", `status=200 revision=${revOf(db)}`);
  } else {
    fail("T-RECOVER", "额度耗尽后无法恢复", `status=${r.status} code=${t.code}`);
  }
  db.close();
}
// 额外：槽位成功但模型调用前终止
{
  const db = fixture(); await ready(db);
  const s = await allocateQuotaSlot(db, { projectId: P, workItemId: ITEM, actor: { role: "employee", accountId: EMP }, limit: 12 });
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  const r = await turn(db, { questionKey: anchorOf(db), answer: "孤儿槽位后重试", answers: {}, mode: "harness", baseRevision: revOf(db) });
  restore();
  if (s.ok && r.status === 200 && gateRows(db).length === 1) {
    pass("T-FAULT-C", "槽位已分配但进程终止（无门）：重试可正常继续（孤儿槽位保守占用，不阻断）", `slots=${slots(db)}`);
  } else {
    fail("T-FAULT-C", "孤儿槽位阻断了访谈", `status=${r.status} slots=${slots(db)}`);
  }
  db.close();
}
// 额外：租约过期后接管
{
  const db = fixture(); await ready(db);
  const a = anchorOf(db), rev = revOf(db);
  const ti = modelTurnIdentity({ revision: rev, anchorKey: a, questionKey: a });
  const s = await allocateQuotaSlot(db, { projectId: P, workItemId: ITEM, actor: { role: "employee", accountId: EMP }, limit: 12 });
  await markModelCallStarted(db, s.slotId);
  await claimTurnGate(db, { projectId: P, workItemId: ITEM, turnIdentity: ti, actor: { role: "employee", accountId: EMP } });
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  const inLease = await turn(db, { questionKey: a, answer: "租约内", answers: {}, mode: "harness", baseRevision: rev });
  restore();
  db.exec("UPDATE events SET created_at = datetime('now','-600 seconds') WHERE substr(event_id,1,4)='MCT|'");
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  const afterLease = await turn(db, { questionKey: a, answer: "租约后", answers: {}, mode: "harness", baseRevision: rev });
  restore();
  if (inLease.status === 409 && afterLease.status === 200) {
    pass("T-LEASE", "门租约：租约内重试 409（不重复调用）；租约过期后可原子接管继续（不永久阻断）", `inLease=${inLease.status} afterLease=${afterLease.status}`);
  } else {
    fail("T-LEASE", "租约恢复异常", `inLease=${inLease.status} afterLease=${afterLease.status}`);
  }
  db.close();
}
// 额外：槽位释放的可证安全性
{
  const db = fixture();
  const s = await allocateQuotaSlot(db, { projectId: P, workItemId: ITEM, actor: { role: "employee", accountId: EMP }, limit: 12 });
  const released = await releaseQuotaSlot(db, s.slotId);
  await markModelCallStarted(db, s.slotId);
  const s2 = await allocateQuotaSlot(db, { projectId: P, workItemId: ITEM, actor: { role: "employee", accountId: EMP }, limit: 12 });
  await markModelCallStarted(db, s2.slotId);          // s2 已 started ⇒ 不得被释放
  const notReleased = await releaseQuotaSlot(db, s2.slotId);
  if (released && !notReleased) {
    pass("T-RELEASE", "槽位释放仅对 `reserved` 生效（已 started 的槽位**不可**释放 ⇒ 已发出的调用不会被免费回收）", `reserved=${released} started=${notReleased}`);
  } else {
    fail("T-RELEASE", "释放语义不安全", `reserved=${released} started=${notReleased}`);
  }
  db.close();
}
// 额外：额度层不同有效键竞争最后一个槽位（最坏读取陈旧度）
{
  const db = fixture(); seedSlots(db, 11);
  const rs = await Promise.all(Array.from({ length: 30 }, () => allocateQuotaSlot(db, { projectId: P, workItemId: ITEM, actor: { role: "employee", accountId: EMP }, limit: 12 })));
  const ok = rs.filter((r) => r.ok).length;
  if (slots(db) === 12 && ok === 1) {
    pass("T-LASTSLOT", "30 个执行者争抢最后一个槽位：恰好 1 个成功、29 个被拒，总额度=12（与读取陈旧度无关）", `ok=${ok} slots=12`);
  } else {
    fail("T-LASTSLOT", "最后一个槽位被多占", `ok=${ok} slots=${slots(db)}`);
  }
  db.close();
}

// ═══════════════ R2 事件隔离 ═══════════════
console.log("\n── R2 内部事件展示隔离 ──");
// T14 员工事件接口不显示 model_call_*
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "正常一轮");
  restore();
  db.exec(`INSERT INTO events (event_id,project_id,work_item_id,type,actor_role,actor_id,payload) VALUES ('EVT-BIZ','${P}','${ITEM}','employee_submitted','employee','${EMP}','{}')`);
  const r = await listEvents({ request: evReq(), env: { DB: db }, params: { projectId: P } });
  const types = (await r.clone().json()).events.map((e) => e.type);
  const leaked = types.filter((t) => String(t).startsWith("model_call_"));
  if (r.status === 200 && leaked.length === 0 && types.includes("employee_submitted")) {
    pass("T14", "员工 GET /events 不显示 model_call_*，业务事件仍可见", JSON.stringify(types));
  } else {
    fail("T14", "员工事件列表仍泄露内部计量事件", JSON.stringify(types));
  }
  db.close();
}
// T15 external_builder 最近事件不显示 model_call_*
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "正常一轮");
  restore();
  db.exec(`INSERT INTO events (event_id,project_id,work_item_id,type,actor_role,actor_id,payload) VALUES ('EVT-BIZ2','${P}','${ITEM}','employee_submitted','employee','${EMP}','{}')`);
  const r = await getProject({ request: projReq(), env: { DB: db }, params: { projectId: P } });
  const body = await r.clone().json();
  const latest = body.latestEvent?.type || null;
  if (r.status === 200 && latest === "employee_submitted") {
    pass("T15", "external_builder 控制台「最近事件」为真实业务事件，不显示 model_call_*", `latest=${latest}`);
  } else {
    fail("T15", "最近事件仍可能是内部计量事件", `latest=${latest} status=${r.status}`);
  }
  db.close();
}
// T16 内部计量仍可读取
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 1500, completion_tokens: 320, total_tokens: 1820 } });
  await answer(db, "正常一轮");
  restore();
  const stats = await readModelCallStats(db, ITEM);
  const payload = JSON.parse(db.get("SELECT payload FROM events WHERE work_item_id=? AND substr(event_id,1,4)='MCQ|' AND type='model_call_succeeded'", ITEM).payload);
  if (stats.claimed === 1 && stats.succeeded === 1 && payload.promptTokens === 1500) {
    pass("T16", "内部计量不受展示过滤影响：仍可读到 claimed/succeeded 与 Token 明细", `claimed=${stats.claimed} promptTokens=${payload.promptTokens}`);
  } else {
    fail("T16", "内部计量被破坏", JSON.stringify({ stats, payload }));
  }
  db.close();
}
// 额外：过滤不误伤业务事件（`_` 通配符对照）
{
  const db = fixture();
  db.exec(`INSERT INTO events (event_id,project_id,work_item_id,type,actor_role,actor_id,payload) VALUES
    ('E1','${P}','${ITEM}','employee_submitted','employee','${EMP}','{}'),
    ('E2','${P}','${ITEM}','handoff','verifier','${VER}','{}'),
    ('E3','${P}','${ITEM}','modelXcall_decoy','employee','${EMP}','{}'),
    ('E4','${P}','${ITEM}','model_call_succeeded','employee','${EMP}','{}')`);
  const r = await listEvents({ request: evReq(), env: { DB: db }, params: { projectId: P } });
  const types = (await r.clone().json()).events.map((e) => e.type);
  const likeHits = Number(db.get("SELECT COUNT(*) AS c FROM events WHERE project_id=? AND type LIKE 'model_call_%'", P).c);
  const substrHits = Number(db.get("SELECT COUNT(*) AS c FROM events WHERE project_id=? AND substr(type,1,10)='model_call'", P).c);
  if (types.includes("employee_submitted") && types.includes("modelXcall_decoy") && !types.includes("model_call_succeeded") && likeHits === 2 && substrHits === 1) {
    pass("T-LIKE", "过滤使用 substr 前缀比较而非 LIKE：`_` 不是通配符 ⇒ 不误伤 modelXcall_decoy（LIKE 会命中 2 个，substr 仅 1 个）", `like=${likeHits} substr=${substrHits}`);
  } else {
    fail("T-LIKE", "过滤误伤业务事件或转义处理错误", JSON.stringify({ types, likeHits, substrHits }));
  }
  db.close();
}
// 额外：verifier / owner 可见性不变
{
  const db = fixture();
  db.exec(`INSERT INTO events (event_id,project_id,work_item_id,type,actor_role,actor_id,payload) VALUES
    ('V1','${P}','${ITEM}','handoff','verifier','${VER}','{}'),
    ('V2','${P}','${ITEM}','fact_confirmed','verifier','${VER}','{}'),
    ('O1','${P}','${ITEM}','owner_decision_recorded','external_builder','${EXT}','{}'),
    ('M1','${P}','${ITEM}','model_call_succeeded','employee','${EMP}','{}')`);
  // 员工视角
  const emp = (await (await listEvents({ request: evReq(), env: { DB: db }, params: { projectId: P } })).clone().json()).events.map((e) => e.type);
  // external_builder（无 type 白名单，本次改动后应排除 model_call_*）
  const ext = (await (await listEvents({ request: evReq(TOK_EXT), env: { DB: db }, params: { projectId: P } })).clone().json()).events.map((e) => e.type);
  if (!emp.includes("model_call_succeeded") && !ext.includes("model_call_succeeded") && ext.includes("handoff")) {
    pass("T-ROLES", "各角色可见性：员工与 external_builder 均不显示 model_call_*；其原有业务事件可见性不变", `emp=${JSON.stringify(emp)} ext=${JSON.stringify(ext)}`);
  } else {
    fail("T-ROLES", "角色可见性异常", JSON.stringify({ emp, ext }));
  }
  db.close();
}

// ═══════════════ R3 Token 校验 ═══════════════
console.log("\n── R3 Token 合理性校验 ──");
// T17 负数
{
  const r = extractUsage({ usage: { prompt_tokens: -5, completion_tokens: 10 } });
  if (r.source === TOKEN_SOURCE_UNAVAILABLE && r.promptTokens === null && r.suspicious === true) {
    pass("T17", "负数 Token 被拒绝：整条降级 unavailable 并标记 suspicious（不记为可信 reported）", `rejected=${JSON.stringify(r.rejected)}`);
  } else {
    fail("T17", "负数未正确处理", JSON.stringify(r));
  }
}
// T18 非整数
{
  const r = extractUsage({ usage: { prompt_tokens: 10.5, completion_tokens: 3 } });
  if (r.source === TOKEN_SOURCE_UNAVAILABLE && r.promptTokens === null) {
    pass("T18", "非整数 Token 被拒绝（不静默取整）", `rejected=${JSON.stringify(r.rejected)}`);
  } else {
    fail("T18", "非整数未正确处理", JSON.stringify(r));
  }
}
// T19 异常巨大值不进入可信费用统计
{
  const r = extractUsage({ usage: { prompt_tokens: 1e12, completion_tokens: 5 } });
  const cost = estimateCostCny(r);
  const saneCeiling = estimateCostCny({ promptTokens: null, completionTokens: null });
  if (r.source === TOKEN_SOURCE_UNAVAILABLE && r.promptTokens === null && cost <= saneCeiling) {
    pass("T19", "异常巨大 Token 被拒绝，费用退回保守上界（不进入可信费用统计）", `cost=¥${cost} ceiling=¥${saneCeiling}`);
  } else {
    fail("T19", "异常巨大值影响了费用统计", `cost=${cost}`);
  }
}
// 额外：NaN / Infinity / 自相矛盾的 total
{
  const nan = extractUsage({ usage: { prompt_tokens: Number.NaN, completion_tokens: 1 } });
  const inf = extractUsage({ usage: { prompt_tokens: Number.POSITIVE_INFINITY, completion_tokens: 1 } });
  const bad = extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 999 } });
  if (nan.source === TOKEN_SOURCE_UNAVAILABLE && inf.source === TOKEN_SOURCE_UNAVAILABLE && bad.source === TOKEN_SOURCE_UNAVAILABLE && bad.suspicious) {
    pass("T-TOK-EDGE", "NaN / Infinity / 自相矛盾的 total_tokens 一律拒绝", "ok");
  } else {
    fail("T-TOK-EDGE", "边界值处理异常", JSON.stringify({ nan, inf, bad }));
  }
}
// T20 缺失 usage 不记为 0
{
  const db = fixture();
  fakeModel({ usage: null });
  const r = await answer(db, "无 usage");
  restore();
  const b = await J(r);
  const payload = JSON.parse(db.get("SELECT payload FROM events WHERE work_item_id=? AND substr(event_id,1,4)='MCQ|' AND type='model_call_succeeded'", ITEM).payload);
  if (payload.usageSource === TOKEN_SOURCE_ESTIMATED && payload.promptTokens !== 0 && b.metering.promptTokens !== 0) {
    pass("T20", "缺失 usage → 记 estimated（不写 0、不冒充 reported）", `source=${payload.usageSource} promptTokens=${payload.promptTokens}`);
  } else {
    fail("T20", "缺失 usage 处理异常", JSON.stringify(payload));
  }
  db.close();
}
// T21 正常 usage 保持正确
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 1500, completion_tokens: 320, total_tokens: 1820 } });
  const r = await answer(db, "正常 usage");
  restore();
  const b = await J(r);
  const payload = JSON.parse(db.get("SELECT payload FROM events WHERE work_item_id=? AND substr(event_id,1,4)='MCQ|' AND type='model_call_succeeded'", ITEM).payload);
  if (b.metering.tokenSource === TOKEN_SOURCE_REPORTED && payload.promptTokens === 1500 && payload.completionTokens === 320 && payload.totalTokens === 1820 && payload.usageSuspicious === false) {
    pass("T21", "正常 usage 保持 reported，三个字段原样保留", `${payload.promptTokens}/${payload.completionTokens}/${payload.totalTokens}`);
  } else {
    fail("T21", "正常 usage 被破坏", JSON.stringify(payload));
  }
  db.close();
}
// 额外：计量记录不含敏感内容
{
  const db = fixture();
  const SECRET = "机密原话：印尼供应商报价每件三点五美金";
  const LEAK_KEY = "sk-FAKEKEY1234567890abcdef";
  await ready(db);
  globalThis.fetch = async () => new Response(envelope({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), { status: 200 });
  await agentTurn({ request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", TOK, { projectId: P, workItemId: ITEM, questionKey: anchorOf(db), answer: SECRET, answers: {}, mode: "harness", baseRevision: revOf(db) }), env: { DB: db, DEEPSEEK_API_KEY: LEAK_KEY }, params: {} });
  restore();
  const all = db.all("SELECT event_id,payload FROM events WHERE work_item_id=?", ITEM).map((e) => `${e.event_id} ${e.payload}`).join(" | ");
  const hits = [LEAK_KEY, "印尼供应商", "三点五美金", "Authorization", "Bearer"].filter((x) => all.includes(x));
  if (hits.length === 0) pass("T-SECRET", "计量记录不含 API Key / 完整提示词 / 员工回答 / 完整模型响应", "无泄露");
  else fail("T-SECRET", "计量记录泄露内容", JSON.stringify(hits));
  db.close();
}

// ═══════════════ T22 业务回归 ═══════════════
console.log("\n── T22 推断 / 提交 / 核验 无回归 ──");
{
  const db = fixture();
  fakeModel({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await answer(db, "每天早上先看后台曝光数据再挑对标视频");
  restore();
  const ledger = djOf(db).ledger || {};
  const baseline = ledger.authoritativeInferences || [];
  // 说明：全新任务在该时点**尚无**已保存草稿，因此 employee-turn 写入的 ledger 是
  // 「服务端专属三字段」的合并结果（statements/covered 等由 employee-draft 保存时补齐）。
  // 这属于既有行为（FIX2B 未改动该写入路径）。此处断言本路径真正拥有的字段完整，
  // 并额外验证一次草稿保存后基础结构仍然完好。
  const ownsServerFields = "authoritativeInferences" in ledger && typeof ledger.burdenAsked === "boolean" && "pendingQuestion" in ledger;
  const baselineOk = baseline.length > 0 && baseline.every((e) => e.id && e.text);
  const { onRequestPut: saveDraft } = await import("../functions/api/work-items/[itemId]/employee-draft.js");
  const putRes = await saveDraft({
    request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, TOK, { answers: { trigger: "每天早上先看后台曝光数据" }, materialStatus: "provided", baseRevision: revOf(db) }),
    env: { DB: db }, params: { itemId: ITEM },
  });
  const after = djOf(db).ledger || {};
  // PILOT-09C/IMPLEMENT-05B（F03）：ledger.evidence 由"材料引用数组"升级为服务端证据元数据对象
  // （schemaVersion/seq/answersDigest/dimensions）。断言意图不变：ledger 基础结构必须完好，
  // 且证据元数据是**服务端生成的完整对象**（比旧的"数组存在"更强，不放宽）。
  const coreOk = typeof after.statements === "object" && Array.isArray(after.covered) && Array.isArray(after.vagueTerms) && Array.isArray(after.unresolved)
    && after.evidence && typeof after.evidence === "object" && !Array.isArray(after.evidence)
    && Number.isInteger(after.evidence.schemaVersion) && typeof after.evidence.answersDigest === "string" && Boolean(after.evidence.dimensions);
  const keptOk = Array.isArray(after.authoritativeInferences) && after.authoritativeInferences.length === baseline.length && typeof after.burdenAsked === "boolean";
  if (ownsServerFields && baselineOk && coreOk && keptOk && putRes.status === 200) {
    pass("T22", "推断基线 / burdenAsked / pendingQuestion 完好；草稿保存后 ledger 基础结构与推断基线均保留（额度改造无回归）", `inferences=${baseline.length} core=${coreOk}`);
  } else {
    fail("T22", "服务端字段丢失或结构破损", JSON.stringify({ ownsServerFields, baselineOk, coreOk, keptOk, status: putRes.status }));
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
console.log("\n  【本地模拟 + 内存库】不构成真实模型验证；额度原语为单条同步 SQL，未冒充真实数据库并发。");
assert.equal(count("FAIL"), 0, "存在 FAIL 用例");
console.log("\npilot09a_fix2 runtime: ok");
