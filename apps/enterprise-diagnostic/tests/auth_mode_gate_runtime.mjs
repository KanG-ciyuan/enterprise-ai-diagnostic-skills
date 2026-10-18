/**
 * B2-01 鉴权模式门与完整登录链路 —— 运行时行为测试（V0.1 第二批）
 *
 * 覆盖修订稿安全性质 P-5 / P-7 / P-8 / P-10。
 *
 * 设计原则（遵循授权范围 §6）：
 *   · 调用**真实 handler**，断言**可观察状态**（响应体字段 + 数据库行），
 *     不以源码字符串搜索代替行为测试；
 *   · 结果分三类：PASS / FAIL / UNCOVERED；
 *   · UNCOVERED 必须给出测试项、原因与剩余风险，不得计入通过。
 *
 * 覆盖的已确认缺陷：
 *   - 未识别 FORMAL_AUTH_MODE 触发开发登录逻辑（原黑名单判定）
 *   - login-request 在响应体泄露登录 token
 *   - login-consume 缺少模式感知防护
 *   - 开发回退凭证可被兑换为正式会话
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onRequestPost as authorize } from "../functions/api/auth/authorize.js";
import { onRequestPost as loginRequest } from "../functions/api/auth/login-request.js";
import { onRequestPost as loginConsume } from "../functions/api/auth/login-consume.js";
import { onRequestGet as session } from "../functions/api/auth/session.js";
import { onRequestPost as demoEnter } from "../functions/api/demo/enter.js";
import { DEV_FALLBACK_DELIVERY_MARKER, PROVIDER_DELIVERED_MARKER, resolveAuthMode, sha256 } from "../functions/_shared.js";
import { D1Harness } from "./d1_harness.mjs";

const results = [];
const record = (id, name, verdict, note = "") => results.push({ id, name, verdict, note });
const pass = (id, name, note) => record(id, name, "PASS", note);
const fail = (id, name, note) => record(id, name, "FAIL", note);
const uncovered = (id, name, note) => record(id, name, "UNCOVERED", note);

const JSON_POST = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const tokenFromUrl = (url) => decodeURIComponent(String(url || "").split("#login=")[1] || "");
const jsonOf = async (response) => response.json().catch(() => ({}));

const TEST_EMAIL = "tester@v01.invalid";
const REAL_EMAIL = "owner@business.example";

function harness({ emails = [TEST_EMAIL] } = {}) {
  const db = new D1Harness();
  emails.forEach((email, index) => {
    db.exec(`INSERT INTO accounts(id,email,name,status,account_role) VALUES ('ACC-${index + 1}','${email}','测试账号','active','member');`);
  });
  return db;
}

function envFor(db, mode, extra = {}) {
  const env = { DB: db, FORMAL_APP_ORIGIN: "https://example.pages.dev", ...extra };
  if (mode !== undefined) env.FORMAL_AUTH_MODE = mode;
  return env;
}

const callAuthorize = (env, token = "123456") =>
  authorize({ request: new Request("http://127.0.0.1/api/auth/authorize", JSON_POST({ email: "new@biz.example", enterpriseName: "E", bootstrapToken: token })), env });
const callLoginRequest = (env, email) =>
  loginRequest({ request: new Request("http://127.0.0.1/api/auth/login-request", JSON_POST({ email })), env });
const callLoginConsume = (env, token) =>
  loginConsume({ request: new Request("http://127.0.0.1/api/auth/login-consume", JSON_POST({ token })), env });
const callDemoEnter = (env) =>
  demoEnter({ request: new Request("http://127.0.0.1/api/demo/enter", JSON_POST({ role: "owner" })), env });

// ── 模式取值矩阵（全部为"未识别取值必须失效保护"的反向断言）─────────────
const MODES = [
  { label: "production", value: "production", production: true },
  { label: "development", value: "development", production: false },
  { label: "缺失(undefined)", value: undefined, production: true },
  { label: "空串", value: "", production: true },
  { label: "拼写错误 productionn", value: "productionn", production: true },
  { label: "未知取值 staging", value: "staging", production: true },
  { label: "仅空格", value: "   ", production: true },
];

console.log("B2-01 鉴权模式门与完整登录链路\n");

// ── P-5：未知运行模式不能开启开发能力 ─────────────────────────────────
console.log("P-5 未知运行模式不能开启开发能力");
for (const mode of MODES) {
  const db = harness();
  // 故意同时误留测试开关 —— 这是最危险的配置形态
  const env = envFor(db, mode.value, { FORMAL_AUTH_TEST_MODE: "1" });
  const [az, lr, de] = [await callAuthorize(env), await callLoginRequest(env, TEST_EMAIL), await callDemoEnter(env)];
  const lrBody = await jsonOf(lr);
  const actual = { authorize: az.status, demo: de.status, leaked: Boolean(lrBody.loginUrl) };
  const want = mode.production
    ? { authorize: 503, demo: 403, leaked: false }
    : { authorize: 200, demo: 200, leaked: true };
  const ok = actual.authorize === want.authorize && actual.demo === want.demo && actual.leaked === want.leaked;
  const detail = `authorize=${actual.authorize} demo=${actual.demo} leaked=${actual.leaked}`;
  if (ok) pass("P-5", `FORMAL_AUTH_MODE=${mode.label}`, detail);
  else fail("P-5", `FORMAL_AUTH_MODE=${mode.label}`, `${detail} 期望 authorize=${want.authorize} demo=${want.demo} leaked=${want.leaked}`);
  db.close();
}

// ── P-7：登录凭证不得因错误配置泄露 ───────────────────────────────────
console.log("P-7 登录凭证不得因错误配置泄露");
for (const mode of MODES.filter((m) => m.production)) {
  const db = harness({ emails: [TEST_EMAIL, REAL_EMAIL] });
  const env = envFor(db, mode.value, { FORMAL_AUTH_TEST_MODE: "1" });
  // 受控 .invalid 收件人与真实业务邮箱都必须拿不到响应内凭证
  const [controlled, real] = [await jsonOf(await callLoginRequest(env, TEST_EMAIL)), await jsonOf(await callLoginRequest(env, REAL_EMAIL))];
  const leaked = Boolean(controlled.loginUrl) || Boolean(real.loginUrl);
  const hasTokenField = JSON.stringify(controlled).includes("#login=") || JSON.stringify(real).includes("#login=");
  if (!leaked && !hasTokenField) pass("P-7", `${mode.label} · 响应体不含登录凭证`);
  else fail("P-7", `${mode.label} · 响应体泄露凭证`, `controlled=${Boolean(controlled.loginUrl)} real=${Boolean(real.loginUrl)}`);
  db.close();
}
{
  // 开发语义下，真实业务邮箱**同样**不得获得响应内凭证（要求 4.2 的核心）
  const db = harness({ emails: [REAL_EMAIL] });
  const env = envFor(db, "development", { FORMAL_AUTH_TEST_MODE: "1" });
  const body = await jsonOf(await callLoginRequest(env, REAL_EMAIL));
  const row = db.get("SELECT delivery_status,delivery_error FROM member_login_challenges");
  if (!body.loginUrl) pass("P-7", "development + 测试开关 · 真实业务邮箱仍不返回凭证", `challenge=${row?.delivery_status}/${row?.delivery_error}`);
  else fail("P-7", "development + 测试开关 · 真实业务邮箱泄露凭证");
  db.close();
}
{
  // 开发语义但**未**开启测试开关：也不得返回凭证
  const db = harness();
  const env = envFor(db, "development");
  const body = await jsonOf(await callLoginRequest(env, TEST_EMAIL));
  if (!body.loginUrl) pass("P-7", "development 但未开测试开关 · 不返回凭证");
  else fail("P-7", "development 但未开测试开关 · 却返回了凭证");
  db.close();
}

// ── 开发回退凭证的来源标记（§4.4）──────────────────────────────────────
console.log("§4.4 开发回退凭证来源必须可辨");
{
  const db = harness();
  const env = envFor(db, "development", { FORMAL_AUTH_TEST_MODE: "1" });
  await callLoginRequest(env, TEST_EMAIL);
  const row = db.get("SELECT delivery_status,delivery_error FROM member_login_challenges");
  if (row?.delivery_status === "delivered" && row?.delivery_error === DEV_FALLBACK_DELIVERY_MARKER) {
    pass("§4.4", "开发回退凭证被打上来源标记", `${row.delivery_status}/${row.delivery_error}`);
  } else {
    fail("§4.4", "开发回退凭证未标记来源", JSON.stringify(row));
  }
  db.close();
}
{
  // 真实 provider 成功投递：必须带**正向**来源标记（B-1 起）。
  // 说明：B2-01 阶段的契约曾是 delivery_error IS NULL；B-1 复核证明
  // 「delivered + NULL」同时可能表示旧版开发回退，无法区分真实来源，
  // 因此改为正向标记 provider_delivered。此断言随 B-1 一并更新。
  const db = harness();
  const sent = [];
  const env = envFor(db, "production", { MEMBER_LOGIN_PROVIDER: { send: async (m) => sent.push(m) } });
  await callLoginRequest(env, TEST_EMAIL);
  const row = db.get("SELECT delivery_status,delivery_error FROM member_login_challenges");
  if (row?.delivery_status === "delivered" && row?.delivery_error === PROVIDER_DELIVERED_MARKER) {
    pass("§4.4", "真实投递凭证带正向标记 provider_delivered（来源可区分）");
  } else {
    fail("§4.4", "真实投递凭证未带正向来源标记", JSON.stringify(row));
  }
  db.close();
}

// ── P-8：凭证单次消费、有效期与状态限制 ───────────────────────────────
console.log("P-8 凭证单次消费、有效期及状态限制");
const deliveredToken = async (mode = "production", email = TEST_EMAIL) => {
  const db = harness({ emails: [email] });
  const sent = [];
  const env = envFor(db, mode, { MEMBER_LOGIN_PROVIDER: { send: async (m) => sent.push(m) } });
  await callLoginRequest(env, email);
  return { db, env, sent, token: tokenFromUrl(sent[0]?.loginUrl) };
};
{
  const { db, env, token } = await deliveredToken();
  const first = await callLoginConsume(env, token);
  const cookie = (first.headers.get("set-cookie") || "").split(";")[0];
  const sessionResponse = await session({ request: new Request("http://127.0.0.1/api/auth/session", { headers: { cookie } }), env });
  const second = await callLoginConsume(env, token);
  if (first.status === 200 && sessionResponse.status === 200 && second.status === 401 && db.count("sessions") === 1) {
    pass("P-8", "成功消费一次并建立会话；二次消费被拒");
  } else {
    fail("P-8", "单次消费语义不符", `first=${first.status} session=${sessionResponse.status} second=${second.status} sessions=${db.count("sessions")}`);
  }
  db.close();
}
{
  const { db, env, token } = await deliveredToken();
  db.exec("UPDATE member_login_challenges SET expires_at='2020-01-01T00:00:00.000Z'");
  const r = await callLoginConsume(env, token);
  if (r.status === 401 && db.count("sessions") === 0) pass("P-8", "过期凭证被拒绝且不建立会话");
  else fail("P-8", "过期凭证未被拒绝", `${r.status} sessions=${db.count("sessions")}`);
  db.close();
}
{
  const { db, env, token } = await deliveredToken();
  db.exec("UPDATE accounts SET status='suspended'");
  const r = await callLoginConsume(env, token);
  if (r.status === 401 && db.count("sessions") === 0) pass("P-8", "非活动账号被拒绝且不建立会话");
  else fail("P-8", "非活动账号未被拒绝", `${r.status} sessions=${db.count("sessions")}`);
  db.close();
}
{
  const { db, env } = await deliveredToken();
  const before = db.count("sessions");
  const r = await callLoginConsume(env, "not-a-real-token");
  if (r.status === 401 && db.count("sessions") === before) pass("P-8", "非法 token 不创建正式会话");
  else fail("P-8", "非法 token 产生了副作用", `${r.status} delta=${db.count("sessions") - before}`);
  db.close();
}
{
  // 未投递（仍为 dispatching，从未被标记 delivered）的 challenge 不可消费
  const { db, env, token } = await deliveredToken();
  db.exec("UPDATE member_login_challenges SET delivery_status='dispatching', delivery_error=NULL");
  const r = await callLoginConsume(env, token);
  if (r.status === 401) pass("P-8", "未投递状态的凭证不可消费");
  else fail("P-8", "未投递凭证仍可消费", String(r.status));
  db.close();
}

// ── 核心：开发回退凭证在非开发语义下不可兑换 ───────────────────────────
console.log("核心：开发回退凭证不得兑换为正式会话");
{
  // 先以开发语义产出回退凭证，再用生产/未识别语义尝试兑换
  for (const mode of MODES.filter((m) => m.production)) {
    const db = harness();
    const devEnv = envFor(db, "development", { FORMAL_AUTH_TEST_MODE: "1" });
    const devBody = await jsonOf(await callLoginRequest(devEnv, TEST_EMAIL));
    const token = tokenFromUrl(devBody.loginUrl);
    if (!token) { fail("核心", `${mode.label} · 前置：未能产出回退凭证`); db.close(); continue; }
    const consumeEnv = envFor(db, mode.value, { FORMAL_AUTH_TEST_MODE: "1" });
    const r = await callLoginConsume(consumeEnv, token);
    if (r.status === 401 && db.count("sessions") === 0) pass("核心", `${mode.label} 语义下回退凭证被拒绝`);
    else fail("核心", `${mode.label} 语义下回退凭证仍可兑换`, `${r.status} sessions=${db.count("sessions")}`);
    db.close();
  }
}
{
  // 开发语义下回退凭证仍可正常使用（本地便利登录未被破坏）
  const db = harness();
  const env = envFor(db, "development", { FORMAL_AUTH_TEST_MODE: "1" });
  const body = await jsonOf(await callLoginRequest(env, TEST_EMAIL));
  const r = await callLoginConsume(env, tokenFromUrl(body.loginUrl));
  if (r.status === 200) pass("核心", "开发语义下回退凭证仍可用（本地便利登录保持）");
  else fail("核心", "开发语义下回退凭证不可用（破坏了本地开发）", String(r.status));
  db.close();
}

// ── P-10：生产误配置的检测与阻断 ──────────────────────────────────────
console.log("P-10 生产误配置的检测与阻断");
{
  const productionToml = readFileSync(new URL("../deploy/production/wrangler.toml", import.meta.url), "utf8");
  const active = productionToml.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const hasProduction = /^FORMAL_AUTH_MODE = "production"$/m.test(active);
  const hasTestSwitch = /^FORMAL_AUTH_TEST_MODE/m.test(active);
  if (hasProduction && !hasTestSwitch) pass("P-10", "生产交付配置：production 且不含测试开关");
  else fail("P-10", "生产交付配置不合格", `production=${hasProduction} testSwitch=${hasTestSwitch}`);
}
{
  const script = readFileSync(new URL("../scripts/deploy-production.sh", import.meta.url), "utf8");
  const guards = {
    modeProduction: /FORMAL_AUTH_MODE = "production"/.test(script),
    rejectTestSwitch: /FORMAL_AUTH_TEST_MODE/.test(script),
    rejectRootDeploy: /禁止从仓库根目录部署/.test(script),
  };
  if (guards.modeProduction && guards.rejectTestSwitch && guards.rejectRootDeploy) pass("P-10", "部署脚本含三项最小静态校验", JSON.stringify(guards));
  else fail("P-10", "部署脚本静态校验不完整", JSON.stringify(guards));
}
{
  // 静态校验只是纵深防御的一层，不能被当作不可绕过的门禁 —— 记录该限制。
  uncovered("P-10", "部署脚本静态校验的可绕过性", "静态检查仅在执行该脚本时生效；直接的 wrangler 部署不经过它。运行时保护（resolveAuthMode + 三条件 + login-consume 守卫）才是充分防线，已由 P-5/P-7 与核心用例覆盖。剩余风险：绕过脚本且同时误配 development 时，便利登录仅在受控 .invalid 收件人下可用（已由 P-7 锁定）。");
}
{
  // 真实 Cloudflare 平台上是否强制了 FORMAL_AUTH_MODE —— 本轮无权限验证
  uncovered("P-10", "平台级强制限制是否存在", "需要读取生产 Pages 项目的环境变量实际取值，属生产操作，本轮授权明确禁止。剩余风险：无法证明线上当前取值一定为 production；但即使被误设为 development，真实业务邮箱也不会获得响应内凭证（P-7 已锁定）。");
}

// ── resolveAuthMode 单元级行为（唯一判定实现）─────────────────────────
console.log("resolveAuthMode 判定语义");
{
  const expectations = [
    ["production", { isProduction: true, isDevelopment: false, unrecognized: false }],
    ["development", { isProduction: false, isDevelopment: true, unrecognized: false }],
    [undefined, { isProduction: true, isDevelopment: false, unrecognized: true }],
    ["", { isProduction: true, isDevelopment: false, unrecognized: true }],
    ["productionn", { isProduction: true, isDevelopment: false, unrecognized: true }],
    ["staging", { isProduction: true, isDevelopment: false, unrecognized: true }],
  ];
  let ok = true; const notes = [];
  for (const [raw, want] of expectations) {
    const got = resolveAuthMode(raw === undefined ? {} : { FORMAL_AUTH_MODE: raw });
    const match = got.isProduction === want.isProduction && got.isDevelopment === want.isDevelopment && got.unrecognized === want.unrecognized;
    if (!match) { ok = false; notes.push(`${raw === undefined ? "(缺失)" : raw} → ${JSON.stringify({ p: got.isProduction, d: got.isDevelopment, u: got.unrecognized })}`); }
  }
  if (ok) pass("模式语义", "7 类取值判定符合失效保护语义");
  else fail("模式语义", "判定不符", notes.join("; "));
}
{
  // 未识别取值 + 显式测试开关：也不得开启开发能力
  const got = resolveAuthMode({ FORMAL_AUTH_MODE: "productionn", FORMAL_AUTH_TEST_MODE: "1" });
  if (got.isTestMode === false) pass("模式语义", "未识别取值 + TEST_MODE=1 → isTestMode 仍为 false");
  else fail("模式语义", "未识别取值 + TEST_MODE=1 竟开启测试模式");
}


// ── B-1：历史登录 challenge 来源歧义修复 ────────────────────────────────
console.log("B-1 历史 challenge 来源歧义（正向来源标记）");

// 合法的 provider_delivered 标记形态（T5 断言用）
const MARKER_WRITE = "UPDATE member_login_challenges SET delivery_error=? WHERE id=? AND token_hash=?";
const isMarkerWrite = (statement) =>
  typeof statement?.sql === "string" &&
  statement.sql.includes("SET delivery_error=?") &&
  statement.sql.includes("member_login_challenges") &&
  !statement.sql.includes("delivery_status='failed'");

/** 直接构造指定来源形态的 challenge 行（绕过 login-request），交给新 login-consume 消费。 */
async function legacyChallengeCase({ deliveryError, mode, label, id, verdict }) {
  const db = harness({ emails: [TEST_EMAIL] });
  const token = `b1-${id}-${Math.random().toString(36).slice(2)}`;
  const tokenHash = await sha256(token);
  db.exec(`INSERT INTO member_login_challenges(id,account_id,token_hash,expires_at,delivery_status,delivery_error) VALUES ('CH-${id}','ACC-1','${tokenHash}','2099-01-01T00:00:00.000Z','delivered',${deliveryError === null ? "NULL" : `'${deliveryError}'`})`);
  const env = envFor(db, mode);
  const response = await callLoginConsume(env, token);
  const sessions = db.count("sessions");
  const ok = verdict === "allow" ? response.status === 200 && sessions === 1 : response.status === 401 && sessions === 0;
  const detail = `HTTP=${response.status} sessions=${sessions} delivery_error=${deliveryError === null ? "NULL" : deliveryError}`;
  if (ok) pass("B-1", label, detail);
  else fail("B-1", label, `${detail}（期望 ${verdict === "allow" ? "200 且建立会话" : "401 且不建会话"}）`);
  db.close();
}

// T1：旧版 delivered + NULL 在 production 下拒绝（核心缺口）
await legacyChallengeCase({ id: "T1", deliveryError: null, mode: "production", verdict: "deny", label: "T1 旧版 delivered+NULL · production → 拒绝" });
// T2：旧版 no_provider_manual_link 在 production 下拒绝
await legacyChallengeCase({ id: "T2", deliveryError: "no_provider_manual_link", mode: "production", verdict: "deny", label: "T2 旧版 no_provider_manual_link · production → 拒绝" });
// T3：新版 provider_delivered 在 production 下正常消费
await legacyChallengeCase({ id: "T3", deliveryError: PROVIDER_DELIVERED_MARKER, mode: "production", verdict: "allow", label: "T3 新标记 provider_delivered · production → 允许" });
// T4：dev_fallback_link 在 production 下拒绝
await legacyChallengeCase({ id: "T4", deliveryError: DEV_FALLBACK_DELIVERY_MARKER, mode: "production", verdict: "deny", label: "T4 dev_fallback_link · production → 拒绝" });
// 未知来源标记在 production 下拒绝
await legacyChallengeCase({ id: "TX", deliveryError: "something_else", mode: "production", verdict: "deny", label: "未知来源标记 · production → 拒绝" });
// T7：未知模式值下历史无标记凭证同样被拒绝
await legacyChallengeCase({ id: "T7a", deliveryError: null, mode: "productionn", verdict: "deny", label: "T7 历史无标记凭证 · 拼写错误模式 → 拒绝" });
await legacyChallengeCase({ id: "T7b", deliveryError: null, mode: "", verdict: "deny", label: "T7 历史无标记凭证 · 空串模式 → 拒绝" });
await legacyChallengeCase({ id: "T7c", deliveryError: null, mode: undefined, verdict: "deny", label: "T7 历史无标记凭证 · 模式缺失 → 拒绝" });
// 开发语义不受来源限制（既有受控测试登录能力不变）
await legacyChallengeCase({ id: "TD", deliveryError: null, mode: "development", verdict: "allow", label: "开发语义 · 不限制来源（能力保持）" });

// T3 的链路版：真实 provider 投递后落库标记必须是 provider_delivered 且可消费
{
  const db = harness();
  const sent = [];
  const env = envFor(db, "production", { MEMBER_LOGIN_PROVIDER: { send: async (m) => sent.push(m) } });
  await callLoginRequest(env, TEST_EMAIL);
  const row = db.get("SELECT delivery_status,delivery_error FROM member_login_challenges");
  const consumed = await callLoginConsume(env, tokenFromUrl(sent[0]?.loginUrl));
  if (row?.delivery_error === PROVIDER_DELIVERED_MARKER && row?.delivery_status === "delivered" && consumed.status === 200) {
    pass("B-1", "T3b provider 成功投递 → 落库 provider_delivered 并可消费", `${row.delivery_status}/${row.delivery_error}`);
  } else {
    fail("B-1", "T3b provider 成功投递未正确打标", JSON.stringify(row) + ` HTTP=${consumed.status}`);
  }
  db.close();
}

// T5：provider 投递失败时不得写入 provider_delivered
{
  const db = harness();
  const env = envFor(db, "production", { MEMBER_LOGIN_PROVIDER: { send: async () => { throw new Error("smtp_down"); } } });
  const response = await callLoginRequest(env, TEST_EMAIL);
  const row = db.get("SELECT delivery_status,delivery_error FROM member_login_challenges");
  const ok = row?.delivery_error !== PROVIDER_DELIVERED_MARKER && row?.delivery_status === "failed";
  if (ok) pass("B-1", "T5 provider 投递失败 → 未写正向标记", `${row.delivery_status}/${row.delivery_error}`);
  else fail("B-1", "T5 provider 失败却写了正向标记或状态异常", JSON.stringify(row));
  // 失败响应保持防枚举统一文案
  const body = await jsonOf(response);
  if (response.status === 202 && !body.loginUrl) pass("B-1", "T5b 投递失败响应保持统一文案且不含链接");
  else fail("B-1", "T5b 投递失败响应异常", `HTTP=${response.status} leaked=${Boolean(body.loginUrl)}`);
  db.close();
}

// T6：provider 成功但来源标记写入失败 → 不得产生可在生产语义下消费的凭证
for (const [mode, inject] of [
  ["标记写入抛错", (db) => { const real = db.runStatement.bind(db); db.runStatement = (st) => { if (isMarkerWrite(st)) throw new Error("db_write_failed"); return real(st); }; }],
  ["标记写入静默丢弃(changes=0)", (db) => { const real = db.runStatement.bind(db); db.runStatement = (st) => { if (isMarkerWrite(st)) return { success: true, meta: { changes: 0 } }; return real(st); }; }],
]) {
  const db = harness();
  const sent = [];
  const env = envFor(db, "production", { MEMBER_LOGIN_PROVIDER: { send: async (m) => sent.push(m) } });
  inject(db);
  const response = await callLoginRequest(env, TEST_EMAIL);
  const row = db.get("SELECT delivery_status,delivery_error,consumed_at FROM member_login_challenges");
  const consume = await callLoginConsume(env, tokenFromUrl(sent[0]?.loginUrl) || "no-token");
  const sessions = db.count("sessions");
  const ok = response.status === 503
    && row?.delivery_error !== PROVIDER_DELIVERED_MARKER
    && row?.consumed_at !== null
    && consume.status === 401
    && sessions === 0;
  if (ok) pass("B-1", `T6 ${mode} → fail-closed`, `HTTP=${response.status} 落库=${row?.delivery_status}/${row?.delivery_error} 已作废=是 消费=${consume.status} sessions=0`);
  else fail("B-1", `T6 ${mode} 未正确失败关闭`, `HTTP=${response.status} 落库=${JSON.stringify(row)} 消费=${consume.status} sessions=${sessions}`);
  db.close();
}

// T8：development + 测试开关关闭时 demo/enter 的实际行为（只固定既有行为，不修改 demo/enter）
{
  const db = harness();
  const env = envFor(db, "development");   // 无 FORMAL_AUTH_TEST_MODE
  const response = await callDemoEnter(env);
  if (response.status === 200) {
    pass("B-1", "T8 development + 测试开关关闭 → demo/enter 仍开放（既有行为，已固定）",
      "演示入口的开放条件是「显式 development」，与测试开关无关");
  } else {
    fail("B-1", "T8 development + 测试开关关闭 → demo/enter 行为与既有记录不符", `HTTP=${response.status}`);
  }
  db.close();
}
{
  const db = harness();
  const env = envFor(db, "development");
  const body = await jsonOf(await callLoginRequest(env, TEST_EMAIL));
  if (!body.loginUrl) pass("B-1", "T8b development + 测试开关关闭 → 便利登录不发链接");
  else fail("B-1", "T8b development 未开测试开关却发了登录链接");
  db.close();
}
{
  // 反向对照：非 development 时 demo/enter 必须关闭
  for (const mode of [undefined, "", "productionn", "staging"]) {
    const db = harness();
    const response = await callDemoEnter(envFor(db, mode));
    if (response.status === 403) pass("B-1", `T8c demo/enter 在非 development（${mode === undefined ? "缺失" : mode === "" ? "空串" : mode}）→ 403`);
    else fail("B-1", `T8c demo/enter 在非 development 未关闭`, `mode=${String(mode)} HTTP=${response.status}`);
    db.close();
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────
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
console.log("\nauth mode gate runtime: ok");
